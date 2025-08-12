import ImageArena from "@/components/arena/ImageArena";
import { Helmet } from "react-helmet-async";

const Index = () => {
  return (
    <main className="min-h-screen bg-gradient-to-br from-background to-muted/40 py-14">
      <Helmet>
        <title>Image Model Arena — Blind Image Comparison</title>
        <meta name="description" content="Blind pairwise image comparison arena. Upload images from two models and export results as JSON." />
        <link rel="canonical" href="/" />
      </Helmet>

      <section className="container mb-10 text-center">
        <h1 className="text-4xl font-bold mb-3">Image Model Arena</h1>
      </section>

      <section className="container">
        <ImageArena />
      </section>
    </main>
  );
};

export default Index;
