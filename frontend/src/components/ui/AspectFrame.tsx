import { motion } from "framer-motion";

const RATIO_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i;

function toCssAspectRatio(ratio: string): string {
  const match = RATIO_PATTERN.exec(ratio);
  if (!match) return "16 / 9";
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? `${width} / ${height}` : "16 / 9";
}

// ---------------------------------------------------------------------------
// AspectFrame
// ---------------------------------------------------------------------------

interface AspectFrameProps {
  ratio: string;
  children: React.ReactNode;
  className?: string;
}

export function AspectFrame({ ratio, children, className }: AspectFrameProps) {
  return (
    <motion.div
      layout
      className={`overflow-hidden rounded-lg ${className ?? ""}`}
      style={{
        aspectRatio: toCssAspectRatio(ratio),
        background: "oklch(0.16 0.010 265 / 0.5)",
      }}
    >
      {children}
    </motion.div>
  );
}
