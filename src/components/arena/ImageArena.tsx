import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Helmet } from "react-helmet-async";

export type ArenaResult = {
  timestamp: string;
  models: [string, string];
  roundsPlanned: number;
  roundsCompleted: number;
  winsByModel: Record<string, number>;
  ties: number;
  bothBad: number;
  votes: Array<{
    round: number;
    left: { name: string; model: string; id: string };
    right: { name: string; model: string; id: string };
    choice: "left" | "right" | "tie" | "both";
    winnerModel?: string | null;
  }>;
};

type LoadedImage = {
  file?: File;
  url: string;
  model: string;
  name: string;
  id: string; // identifier after model prefix (e.g., 001)
  source: "upload" | "public";
};

function parseModelPrefix(filename: string): string {
  const base = filename.replace(/\.[^/.]+$/, "");
  const partsByUnderscore = base.split("_");
  const partsByDash = base.split("-");
  const pick = partsByUnderscore.length <= partsByDash.length ? partsByUnderscore : partsByDash;
  return pick[0] || "model";
}

function parseIdSuffix(filename: string, modelPrefix?: string): string {
  const base = filename.replace(/\.[^/.]+$/, "");
  let rest = base;
  if (modelPrefix && base.toLowerCase().startsWith(modelPrefix.toLowerCase())) {
    rest = base.slice(modelPrefix.length);
  } else {
    const idxUnd = base.indexOf("_");
    const idxDash = base.indexOf("-");
    const indices = [idxUnd, idxDash].filter((i) => i >= 0).sort((a, b) => a - b);
    const idx = indices.length ? indices[0] : -1;
    rest = idx >= 0 ? base.slice(idx + 1) : base;
  }
  rest = rest.replace(/^[\-_.\s]+/, "");
  return rest || base;
}

function downloadJSON(filename: string, data: any) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ImageArena({ defaultRounds = 20 }: { defaultRounds?: number }) {
  const [rounds, setRounds] = useState<number>(defaultRounds);
  const [images, setImages] = useState<LoadedImage[]>([]);
  const [phase, setPhase] = useState<"config" | "playing" | "results">("config");
  const [current, setCurrent] = useState(0);
  const [pairs, setPairs] = useState<Array<{ left: LoadedImage; right: LoadedImage }>>([]);
  const votesRef = useRef<ArenaResult["votes"]>([]);

  const withBase = (path: string) => {
    const envBase = (import.meta as any)?.env?.BASE_URL ?? "/";
    let base = envBase;
    if (!base || base === "/") {
      // Fallback for GitHub Pages project sites
      try {
        const isGh = typeof window !== "undefined" && window.location.hostname.endsWith("github.io");
        if (isGh) {
          const segments = window.location.pathname.split("/").filter(Boolean);
          if (segments.length > 0) base = `/${segments[0]}/`;
        }
      } catch {}
    }
    const a = base.endsWith("/") ? base.slice(0, -1) : base;
    const b = path.startsWith("/") ? path : `/${path}`;
    return `${a}${b}`;
  };

  function mergeUniqueByUrl(existing: LoadedImage[], incoming: LoadedImage[]) {
    const seen = new Set(existing.map((i) => i.url));
    const merged = existing.slice();
    for (const item of incoming) {
      if (!seen.has(item.url)) {
        merged.push(item);
        seen.add(item.url);
      }
    }
    return merged;
  }

  const models = useMemo(() => {
    const set = new Set(images.map((i) => i.model));
    return Array.from(set).slice(0, 2) as [string, string];
  }, [images]);

  const grouped = useMemo(() => {
    const map: Record<string, LoadedImage[]> = {};
    for (const img of images) {
      if (!map[img.model]) map[img.model] = [];
      map[img.model].push(img);
    }
    return map;
  }, [images]);

function onFileChange(files: FileList | null) {
  if (!files || files.length === 0) return;
  const imgs: LoadedImage[] = [];
  for (const f of Array.from(files)) {
    if (!f.type.startsWith("image/")) continue;
    const url = URL.createObjectURL(f);
    const model = parseModelPrefix(f.name);
    const id = parseIdSuffix(f.name, model);
    imgs.push({ file: f, url, model, name: f.name, id, source: "upload" });
  }
  if (imgs.length === 0) {
    toast.error("Please select image files.");
    return;
  }
  setImages((prev) => mergeUniqueByUrl(prev, imgs));
  const total = imgs.length;
  const modelsDetected = new Set(imgs.map((i) => i.model)).size;
  toast.success(`Added ${total} images from upload across ${modelsDetected} models.`);
}

async function loadFromPublicFolder() {
  try {
    // Prefer manifest which is auto-generated by Vite plugin
    let loadedFrom = "manifest" as "listing" | "manifest";
    const supported = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
    let fileNames: string[] = [];
    const m = await fetch(withBase(`images/manifest.json`), { cache: "no-store" });
    if (m.ok) {
      const j = await m.json();
      fileNames = Array.isArray(j) ? j : Array.isArray(j?.files) ? j.files : [];
    }
    if (!fileNames.length) {
      // Try directory listing as a fallback
      const res = await fetch(withBase(`images/`), { cache: "no-store" });
      if (res.ok) {
        const contentType = res.headers.get("Content-Type") || "";
        const text = await res.text();
        const hasHtml = contentType.includes("text/html") || /<html[\s>]/i.test(text);
        if (hasHtml) {
          loadedFrom = "listing";
          const parser = new DOMParser();
          const doc = parser.parseFromString(text, "text/html");
          const links = Array.from(doc.querySelectorAll("a"));
          fileNames = links
            .map((a) => a.getAttribute("href") || "")
            .map((href) => href.split("?")[0])
            .filter((href) => !!href && !href.startsWith(".."))
            .map((href) => (href.endsWith("/") ? href.slice(0, -1) : href))
            .map((href) => href.split("/").pop() || href)
            .filter((name) => supported.some((ext) => name.toLowerCase().endsWith(ext)));
        }
      }
    }

    const unique = Array.from(new Set(fileNames));
    if (unique.length === 0) {
      toast.error("No images found under /images. Ensure files are committed and reloaded.");
      return;
    }

    const publicImgs: LoadedImage[] = unique.map((name) => {
      const baseName = name.split('/').pop() || name;
      const model = parseModelPrefix(baseName);
      const id = parseIdSuffix(baseName, model);
      const url = withBase(`images/${name}`);
      return { url, model, name, id, source: "public" };
    });

    setImages((prev) => mergeUniqueByUrl(prev, publicImgs));
    const modelsDetected = new Set(publicImgs.map((i) => i.model)).size;
    toast.success(
      `Added ${publicImgs.length} public images across ${modelsDetected} models (${loadedFrom}).`
    );
  } catch (err) {
    throw err;
  }
}

function startArena() {
  const [m1, m2] = models;
  if (!m1 || !m2) {
    toast.error("Please provide images from exactly two models (use filename prefixes).");
    return;
  }

  // Build maps by id for each model
  const map1: Record<string, LoadedImage> = {};
  const map2: Record<string, LoadedImage> = {};
  for (const img of images) {
    if (img.model === m1) map1[img.id] = img;
    else if (img.model === m2) map2[img.id] = img;
  }

  const commonIds = Object.keys(map1).filter((id) => map2[id]);
  if (commonIds.length === 0) {
    toast.error("No matching pairs found (match by id after prefix, e.g., A_001 with B_001).");
    return;
  }

  // Shuffle order but keep id-pairing. Limit by rounds.
  const order = commonIds.sort(() => Math.random() - 0.5);
  const maxRounds = Math.min(rounds, order.length);

  const newPairs: Array<{ left: LoadedImage; right: LoadedImage }> = [];
  for (let i = 0; i < maxRounds; i++) {
    const id = order[i];
    const a = map1[id]!;
    const b = map2[id]!;
    if (Math.random() < 0.5) newPairs.push({ left: a, right: b });
    else newPairs.push({ left: b, right: a });
  }

  votesRef.current = [];
  setPairs(newPairs);
  setCurrent(0);
  setPhase("playing");
}

  function vote(choice: "left" | "right" | "tie" | "both") {
    const pair = pairs[current];
    if (!pair) return;

    const winnerModel =
      choice === "left" ? pair.left.model : choice === "right" ? pair.right.model : null;

    votesRef.current.push({
      round: current + 1,
      left: { name: pair.left.name, model: pair.left.model, id: pair.left.id },
      right: { name: pair.right.name, model: pair.right.model, id: pair.right.id },
      choice,
      winnerModel,
    });

    const next = current + 1;
    if (next >= pairs.length) {
      finish();
    } else {
      setCurrent(next);
    }
  }

  function finish() {
    const [m1, m2] = models;
    const winsByModel: Record<string, number> = { [m1]: 0, [m2]: 0 };
    let ties = 0;
    let bothBad = 0;

    for (const v of votesRef.current) {
      if (v.choice === "tie") ties++;
      else if (v.choice === "both") bothBad++;
      else if (v.winnerModel) winsByModel[v.winnerModel]++;
    }

      const result: ArenaResult = {
      timestamp: new Date().toISOString(),
      models: [m1, m2],
      roundsPlanned: rounds,
      roundsCompleted: votesRef.current.length,
      winsByModel,
      ties,
      bothBad,
      votes: votesRef.current,
    };

    const winner =
      winsByModel[m1] === winsByModel[m2]
        ? "tie"
        : winsByModel[m1] > winsByModel[m2]
        ? m1
        : m2;

    toast.success(
      winner === "tie" ? "Result: tie" : `Winner: ${winner}`,
      { duration: 3500 }
    );

    downloadJSON(`image-arena-results-${Date.now()}.json`, { ...result, winner });
    setPhase("results");
  }

  const progress = pairs.length ? Math.round(((current) / pairs.length) * 100) : 0;

  return (
    <div className="w-full">
      <Helmet>
        <title>Image Model Arena — Blind Image Comparison</title>
        <meta name="description" content="Blind pairwise image comparison between two models. Upload, vote, and download JSON results." />
        <link rel="canonical" href="/" />
        <script type="application/ld+json">{JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "Image Model Arena",
          applicationCategory: "Multimedia",
          operatingSystem: "Web",
          description: "Blind pairwise image comparison between two models with JSON export.",
        })}</script>
      </Helmet>

      {phase === "config" && (
        <Card className="mx-auto max-w-5xl backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <CardHeader>
            <CardTitle className="text-2xl">Setup your arena</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-3">
                <Label htmlFor="images">Upload images (both models mixed)</Label>
                <Input id="images" type="file" accept="image/*" multiple onChange={(e) => onFileChange(e.target.files)} />
                <Button variant="outline" className="mt-2" onClick={loadFromPublicFolder}>
                  Load all from /images
                </Button>
                <p className="text-sm text-muted-foreground">
                  Filenames must start with the model prefix. Images are paired by the id after the prefix (e.g., modelA_001 with modelB_001). You can also place files in <code>public/images</code> and click the button to load them.
                </p>
              </div>
              <div className="space-y-3">
                <Label htmlFor="rounds">Rounds</Label>
                <Input id="rounds" type="number" min={1} value={rounds}
                  onChange={(e) => setRounds(Math.max(1, Number(e.target.value)))} />
                <p className="text-sm text-muted-foreground">Max rounds will be limited by the smaller model set.</p>
              </div>
            </div>

            <Separator className="my-6" />
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-sm text-muted-foreground">Detected models</p>
                <div className="mt-2 text-sm">
                  {models && models.length > 0 ? (
                    <ul className="list-disc pl-5">
                      {models.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  ) : (
                    <span>—</span>
                  )}
                </div>
              </div>
              <div className="sm:col-span-2">
                <p className="text-sm text-muted-foreground">Counts by model</p>
                <div className="mt-2 flex gap-6 text-sm">
                  {Object.entries(grouped).map(([m, list]) => (
                    <div key={m}>
                      <span className="font-medium">{m}:</span> {list.length}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-8 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setImages([])} disabled={!images.length}>Clear</Button>
              <Button onClick={startArena} disabled={images.length === 0}>Start Arena</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {phase === "playing" && (
        <div className="mx-auto max-w-6xl">
          <div className="mb-4 text-sm text-muted-foreground">Round {current + 1} / {pairs.length} — {progress}%</div>
          <div className="grid gap-6 md:grid-cols-2">
            {([pairs[current]?.left, pairs[current]?.right] as const).map((img, idx) => (
              <Card key={idx} className="overflow-hidden group">
                <CardContent className="p-0">
                  {img && (
                    <img
                      src={img.url}
                      loading="lazy"
                      alt={`Arena candidate ${idx + 1}`}
                      className="aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-[1.01]"
                    />
                  )}
                </CardContent>
                <div className="p-4 flex gap-3">
                  <Button className="flex-1" onClick={() => vote(idx === 0 ? "left" : "right")}>This one</Button>
                  {idx === 1 && (
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => vote("tie")}>Tie</Button>
                      <Button variant="outline" onClick={() => vote("both")}>Both bad</Button>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {phase === "results" && (
        <Card className="mx-auto max-w-3xl text-center">
          <CardHeader>
            <CardTitle className="text-2xl">Thanks for voting</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">A JSON file with your results has been downloaded.</p>
            <div className="mt-6 flex justify-center gap-3">
              <Button onClick={() => setPhase("config")}>New Session</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
