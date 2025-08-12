import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Helmet } from "react-helmet-async";
import { useEffect, useCallback } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { CheckCircle2, ArrowLeft, ArrowRight } from "lucide-react";

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
    choice: "left" | "right";
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

function normalizeId(id: string): string {
  if (!id) return "";
  const trimmed = String(id).trim();
  const cleaned = trimmed.replace(/^[\-_.\s]+/, "");
  if (/^\d+$/.test(cleaned)) {
    const noLeading = cleaned.replace(/^0+/, "");
    return noLeading === "" ? "0" : noLeading;
  }
  return cleaned;
}

function parseModelPrefix(filename: string): string {
  const base = filename.replace(/\.[^/.]+$/, "");
  const idxUnd = base.indexOf("_");
  const idxDash = base.indexOf("-");
  const indices = [idxUnd, idxDash].filter((i) => i >= 0).sort((a, b) => a - b);
  if (indices.length > 0) {
    return base.slice(0, indices[0]) || "model";
  }
  // No separators found; fall back to the whole base name
  return base || "model";
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
  return normalizeId(rest || base);
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
  const [instructionsById, setInstructionsById] = useState<Record<string, string>>({});
  const votesRef = useRef<ArenaResult["votes"]>([]);
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);
  const [justVoted, setJustVoted] = useState<"left" | "right" | null>(null);

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

  function shuffleArray<T>(items: T[]): T[] {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
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

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (phase !== "playing") return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      vote("left");
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      vote("right");
    }
  }, [phase, current, pairs]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Auto-load assets from public on first render
  useEffect(() => {
    // Intentionally ignore errors here; toasts inside functions will surface issues
    loadFromPublicFolder().catch(() => {});
    loadInstructionsFromPublic().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

async function onCsvChange(files: FileList | null) {
  if (!files || files.length === 0) return;
  const file = files[0];
  try {
    const text = await file.text();
    const parsed = parseInstructionsCSV(text);
    const count = Object.keys(parsed).length;
    if (count === 0) {
      toast.error("No instructions found in the CSV (expect header 'id;instruction' or 'id,instruction').");
      return;
    }
    setInstructionsById(parsed);
    toast.success(`Loaded ${count} instructions.`);
  } catch (err) {
    toast.error("Failed to read CSV file.");
  }
}

async function loadInstructionsFromPublic() {
  try {
    const names = ["instruction.csv", "instructions.csv"]; // prefer singular, then plural
    const loaded: Record<string, string> = {};
    const used: string[] = [];
    for (const name of names) {
      const res = await fetch(withBase(name), { cache: "no-store" });
      if (res.ok) {
        const text = await res.text();
        const parsed = parseInstructionsCSV(text);
        if (Object.keys(parsed).length > 0) {
          Object.assign(loaded, parsed);
          used.push(name);
        }
      }
    }
    const count = Object.keys(loaded).length;
    if (count === 0) {
      toast.error("No CSV found or empty (/instruction.csv or /instructions.csv)");
      return;
    }
    setInstructionsById(loaded);
    toast.success(`Loaded ${count} instructions.`);
  } catch (err) {
    toast.error("Failed to load CSV from public folder");
  }
}

function parseInstructionsCSV(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return map;
  const first = lines[0];
  const semi = (first.match(/;/g) || []).length;
  const comma = (first.match(/,/g) || []).length;
  const delim = semi >= comma ? ";" : ",";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(delim);
    if (idx < 0) continue;
    let id = line.slice(0, idx).trim();
    let instruction = line.slice(idx + 1).trim();
    id = id.replace(/^\"|\"$/g, "");
    instruction = instruction.replace(/^\"|\"$/g, "");
    if (i === 0 && id.toLowerCase() === "id") continue; // skip header
    if (!id) continue;
    const norm = normalizeId(String(id));
    map[String(id)] = instruction;
    map[norm] = instruction;
  }
  return map;
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

    const shuffledNames = shuffleArray(unique);
    const publicImgs: LoadedImage[] = shuffledNames.map((name) => {
      const baseName = name.split('/').pop() || name;
      const model = parseModelPrefix(baseName);
      const id = parseIdSuffix(baseName, model);
      const url = withBase(`images/${name}`);
      return { url, model, name, id, source: "public" };
    });

    setImages((prev) => mergeUniqueByUrl(prev, publicImgs));
    const modelsDetected = new Set(publicImgs.map((i) => i.model)).size;
    toast.success(
      `Loaded ${publicImgs.length} public images across ${modelsDetected} models.`
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

  // Shuffle order but keep id-pairing. Use all pairs.
  const order = shuffleArray(commonIds);

  const newPairs: Array<{ left: LoadedImage; right: LoadedImage }> = [];
  for (const id of order) {
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

  function vote(choice: "left" | "right") {
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
    // For left/right, briefly show a green tick before advancing
    if (choice === "left" || choice === "right") {
      setJustVoted(choice);
      window.setTimeout(() => {
        setJustVoted(null);
        if (next >= pairs.length) finish();
        else setCurrent(next);
      }, 300);
      return;
    }
    // Advance
    if (next >= pairs.length) finish();
    else setCurrent(next);
  }

  function finish() {
    const [m1, m2] = models;
    const winsByModel: Record<string, number> = { [m1]: 0, [m2]: 0 };
    let ties = 0;
    let bothBad = 0;

    for (const v of votesRef.current) {
      if (v.winnerModel) winsByModel[v.winnerModel]++;
    }

      const result: ArenaResult = {
      timestamp: new Date().toISOString(),
      models: [m1, m2],
      roundsPlanned: rounds,
      roundsCompleted: votesRef.current.length,
      winsByModel,
      ties: 0,
      bothBad: 0,
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
            <CardTitle className="text-2xl">Image Model Arena</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-md text-muted-foreground mb-6">
              You are about to start an image arena. For faster voting, use the arrow keys.
            </p>
            {/* <div className="grid gap-4 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <p className="text-md text-muted-foreground">Counts by model</p>
                <div className="mt-2 flex gap-6 text-sm">
                  {Object.entries(grouped).map(([m, list]) => (
                    <div key={m}>
                      <span className="font-medium">{m}:</span> {list.length}
                    </div>
                  ))}
                </div>
              </div>
            </div> */}

            <div className="mt-10 flex justify-center">
              <Button
                onClick={startArena}
                disabled={images.length === 0}
                className="h-12 px-6 text-xl"
              >
                Start Arena
              </Button>
            </div>

            {/* Hidden controls retained for functionality */}
            <div className="hidden">
              <input id="images" type="file" accept="image/*" multiple onChange={(e) => onFileChange((e.target as HTMLInputElement).files)} />
              <input id="csv" type="file" accept=".csv,text/csv" onChange={(e) => onCsvChange((e.target as HTMLInputElement).files)} />
              <button onClick={() => setImages([])}>Clear</button>
            </div>
          </CardContent>
        </Card>
      )}

      {phase === "playing" && (
        <div className="mx-auto max-w-6xl">
          <div className="mb-2 text-sm text-muted-foreground">Round {current + 1} / {pairs.length} — {progress}%</div>
          {pairs[current] && (
            <div className="mb-4 rounded-md border p-4 bg-muted/40">
              {(() => {
                const left = pairs[current]!.left;
                const id = left?.id ?? "";
                const instruction = instructionsById[id];
                return (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Prompt</div>
                    <div className="whitespace-pre-wrap text-sm">{instruction || "—"}</div>
                  </div>
                );
              })()}
            </div>
          )}
          <div className="grid gap-6 md:grid-cols-2">
            {([pairs[current]?.left, pairs[current]?.right] as const).map((img, idx) => (
              <Card key={idx} className="overflow-hidden group relative">
                <CardContent className="p-0">
                  {img && (
                    <div className="aspect-square w-full bg-muted/20 flex items-center justify-center">
                      <img
                        src={img.url}
                        loading="lazy"
                        alt={`Arena candidate ${idx + 1}`}
                        className="max-h-full max-w-full object-contain cursor-zoom-in"
                        onClick={() => setZoomSrc(img.url)}
                      />
                      {justVoted && ((justVoted === "left" && idx === 0) || (justVoted === "right" && idx === 1)) && (
                        <div className="absolute right-2 top-2 rounded-full bg-white/90 p-1 shadow">
                          <CheckCircle2 className="h-6 w-6 text-green-600" />
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
                  <div className="p-4 flex gap-3">
                  <Button className="flex-1 inline-flex items-center justify-center gap-2" onClick={() => vote(idx === 0 ? "left" : "right")} disabled={!!justVoted}>
                    {idx === 0 ? (
                      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    )}
                    <span>This one</span>
                  </Button>
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

      <Dialog open={!!zoomSrc} onOpenChange={(open) => !open && setZoomSrc(null)}>
        <DialogContent className="w-[min(95vw,1200px)] max-w-none p-0 bg-transparent border-0 shadow-none">
          {zoomSrc && (
            <img src={zoomSrc} alt="Zoomed" className="w-full h-[80vh] object-contain bg-black/80" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
