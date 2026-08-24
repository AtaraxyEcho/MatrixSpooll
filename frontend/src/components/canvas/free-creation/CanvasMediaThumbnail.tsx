/* eslint-disable jsx-a11y/media-has-caption */
import { useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { AudioLines, CircleAlert, FileText, ImageOff, Pause, Play } from "lucide-react";
import type { CanvasNodeLabelType } from "./CanvasNodeLabel";

type MediaPhase = "loading" | "ready" | "empty" | "error";

interface CanvasMediaThumbnailProps {
  mediaType: Exclude<CanvasNodeLabelType, "subtitle">;
  label: string;
  src?: string;
  poster?: string;
  pending?: boolean;
  failureMessage?: string;
  mediaId?: string;
  textContent?: ReactNode;
  playLabel?: string;
  pauseLabel?: string;
  onIntrinsicSize?: (width: number, height: number) => void;
  onVideoLoadedMetadata?: (video: HTMLVideoElement) => void;
  onVideoPlay?: (video: HTMLVideoElement) => void;
  onVideoPause?: (video: HTMLVideoElement) => void;
  onVideoTimeUpdate?: (video: HTMLVideoElement) => void;
}

function initialPhase(
  mediaType: CanvasMediaThumbnailProps["mediaType"],
  src: string | undefined,
  pending: boolean,
  failureMessage: string | undefined,
): MediaPhase {
  if (pending) return "loading";
  if (mediaType === "text") return "ready";
  if (mediaType === "audio") return src ? "ready" : failureMessage ? "error" : "empty";
  if (src) return "loading";
  return failureMessage ? "error" : "empty";
}

export function CanvasMediaThumbnail({
  mediaType,
  label,
  src,
  poster,
  pending = false,
  failureMessage,
  mediaId,
  textContent,
  playLabel,
  pauseLabel,
  onIntrinsicSize,
  onVideoLoadedMetadata,
  onVideoPlay,
  onVideoPause,
  onVideoTimeUpdate,
}: CanvasMediaThumbnailProps) {
  const [phase, setPhase] = useState<MediaPhase>(() => initialPhase(mediaType, src, pending, failureMessage));
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const ready = () => setPhase("ready");
  const fail = () => setPhase("error");
  const handleVideo = (callback: ((video: HTMLVideoElement) => void) | undefined) => (
    event: SyntheticEvent<HTMLVideoElement>
  ) => callback?.(event.currentTarget);
  const toggleVideoPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
      return;
    }
    video.pause();
    setPlaying(false);
  };

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[var(--color-surface-2)]"
      data-canvas-media-state={phase}
      aria-busy={phase === "loading"}
    >
      {phase === "loading" ? <div className="canvas-media-skeleton absolute inset-0" aria-hidden /> : null}
      {mediaType === "image" && src ? (
        <img
          src={src}
          alt={label}
          draggable={false}
          loading="lazy"
          decoding="async"
          className={`pointer-events-none h-full w-full select-none object-cover transition-opacity duration-200 ${phase === "ready" ? "opacity-100" : "opacity-0"}`}
          onLoad={(event) => {
            ready();
            onIntrinsicSize?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
          }}
          onError={fail}
        />
      ) : null}
      {mediaType === "video" && src ? (
        <video
          ref={videoRef}
          data-canvas-media-id={mediaId}
          src={src}
          poster={poster}
          preload="metadata"
          muted
          playsInline
          draggable={false}
          className={`pointer-events-none h-full w-full select-none object-cover transition-opacity duration-200 ${phase === "ready" ? "opacity-100" : "opacity-0"}`}
          aria-label={label}
          onLoadedMetadata={(event) => {
            ready();
            onIntrinsicSize?.(event.currentTarget.videoWidth, event.currentTarget.videoHeight);
            onVideoLoadedMetadata?.(event.currentTarget);
          }}
          onError={fail}
          onPlay={(event) => {
            setPlaying(true);
            onVideoPlay?.(event.currentTarget);
          }}
          onPause={(event) => {
            setPlaying(false);
            onVideoPause?.(event.currentTarget);
          }}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={handleVideo(onVideoTimeUpdate)}
        />
      ) : null}
      {mediaType === "video" && src && playLabel && pauseLabel ? (
        <button
          type="button"
          className="focus-ring absolute bottom-2 left-2 z-30 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-white shadow-md backdrop-blur-sm transition-colors hover:bg-black/80"
          aria-label={playing ? pauseLabel : playLabel}
          title={playing ? pauseLabel : playLabel}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            toggleVideoPlayback();
          }}
        >
          {playing ? <Pause className="h-4 w-4" fill="currentColor" aria-hidden /> : <Play className="h-4 w-4" fill="currentColor" aria-hidden />}
        </button>
      ) : null}
      {mediaType === "audio" && src ? (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-5">
          <AudioLines className="h-10 w-10 text-[var(--color-accent-2)]" aria-hidden />
          <audio src={src} preload="none" controls className="w-full" aria-label={label} />
        </div>
      ) : null}
      {mediaType === "text" ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-[var(--color-text-2)]">
          <FileText className="h-10 w-10 text-[var(--color-accent-2)]" aria-hidden />
          <span className="max-w-full truncate text-xs">{textContent ?? label}</span>
        </div>
      ) : null}
      {phase === "empty" || phase === "error" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-surface-2)] px-5 text-center text-[var(--color-text-muted)]">
          {phase === "error" ? <CircleAlert className="h-8 w-8 text-[var(--color-danger)]" aria-hidden /> : <ImageOff className="h-8 w-8" aria-hidden />}
          <span className={`max-w-full text-xs leading-5 ${failureMessage ? "line-clamp-5" : "truncate"}`} title={failureMessage ?? label}>
            {failureMessage ?? label}
          </span>
        </div>
      ) : null}
    </div>
  );
}
