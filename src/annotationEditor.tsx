import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Droplets,
  Eraser,
  MousePointer2,
  Pencil,
  Redo2,
  Square,
  Type,
  X,
} from 'lucide-react';

type AnnotationTool = 'select' | 'pen' | 'arrow' | 'rect' | 'blur' | 'text';
type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type Point = { x: number; y: number };
type Bounds = { x: number; y: number; width: number; height: number };

type AnnotationOp =
  | { type: 'pen'; points: Point[]; color: string; width: number }
  | { type: 'arrow'; from: Point; to: Point; color: string; width: number }
  | { type: 'rect'; from: Point; to: Point; color: string; width: number }
  | { type: 'blur'; from: Point; to: Point; radius: number }
  | { type: 'text'; at: Point; text: string; color: string; fontSize: number };

type MoveState = {
  index: number;
  start: Point;
  original: AnnotationOp;
  previousOps: AnnotationOp[];
  changed: boolean;
};

type ResizeState = {
  index: number;
  handle: ResizeHandle;
  start: Point;
  original: AnnotationOp;
  originalBounds: Bounds;
  previousOps: AnnotationOp[];
  changed: boolean;
};

type AnnotationHistory = {
  ops: AnnotationOp[];
  history: AnnotationOp[][];
  future: AnnotationOp[][];
};

const HISTORY_LIMIT = 50;

type EditingText = {
  opIndex: number | null;
  at: Point;
  text: string;
  color: string;
  fontSize: number;
  left: number;
  top: number;
  scale: number;
};

export type AnnotationSavePayload = {
  pngBase64: string;
  replace: boolean;
  operationCount: number;
};

type AnnotationEditorProps = {
  imageBase64: string;
  title: string;
  replaceDefault?: boolean;
  onClose: () => void;
  onSave: (payload: AnnotationSavePayload) => Promise<void>;
};

const SELECTION_PADDING = 6;

const clampAnnotationSize = (value: number): number =>
  Math.max(3, Math.min(30, Math.round(value)));

const annotationSizeValue = (op: AnnotationOp): number => {
  if (op.type === 'blur') return clampAnnotationSize(op.radius / 2);
  if (op.type === 'text') return clampAnnotationSize(op.fontSize / 4);
  return clampAnnotationSize(op.width);
};

const annotationWithSize = (op: AnnotationOp, size: number): AnnotationOp => {
  const nextSize = clampAnnotationSize(size);
  if (op.type === 'blur') return { ...op, radius: Math.max(8, nextSize * 2) };
  if (op.type === 'text') return { ...op, fontSize: Math.max(18, nextSize * 4) };
  return { ...op, width: nextSize };
};

const normalizeRect = (from: Point, to: Point) => ({
  x: Math.min(from.x, to.x),
  y: Math.min(from.y, to.y),
  width: Math.abs(to.x - from.x),
  height: Math.abs(to.y - from.y),
});

const pointToSegmentDistance = (point: Point, from: Point, to: Point) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSq));
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
};

const translateAnnotation = (op: AnnotationOp, dx: number, dy: number): AnnotationOp => {
  const movePoint = (point: Point) => ({ x: point.x + dx, y: point.y + dy });
  if (op.type === 'pen') return { ...op, points: op.points.map(movePoint) };
  if (op.type === 'text') return { ...op, at: movePoint(op.at) };
  return { ...op, from: movePoint(op.from), to: movePoint(op.to) };
};

const drawArrowHead = (ctx: CanvasRenderingContext2D, from: Point, to: Point, size: number) => {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle - Math.PI / 6), to.y - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(to.x - size * Math.cos(angle + Math.PI / 6), to.y - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
};

const drawAnnotation = (ctx: CanvasRenderingContext2D, op: AnnotationOp) => {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if ('color' in op) {
    ctx.strokeStyle = op.color;
    ctx.fillStyle = op.color;
  }
  if (op.type === 'pen') {
    if (op.points.length < 2) {
      ctx.restore();
      return;
    }
    ctx.lineWidth = op.width;
    ctx.beginPath();
    ctx.moveTo(op.points[0].x, op.points[0].y);
    op.points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.stroke();
  } else if (op.type === 'rect') {
    ctx.lineWidth = op.width;
    ctx.strokeRect(op.from.x, op.from.y, op.to.x - op.from.x, op.to.y - op.from.y);
  } else if (op.type === 'arrow') {
    ctx.lineWidth = op.width;
    ctx.beginPath();
    ctx.moveTo(op.from.x, op.from.y);
    ctx.lineTo(op.to.x, op.to.y);
    ctx.stroke();
    drawArrowHead(ctx, op.from, op.to, Math.max(14, op.width * 3.8));
  } else if (op.type === 'blur') {
    const rect = normalizeRect(op.from, op.to);
    if (rect.width < 2 || rect.height < 2) {
      ctx.restore();
      return;
    }
    // Snapshot only the blur region (plus sampling padding), not the whole
    // canvas: this runs on every redraw, including each pointermove.
    const padding = Math.ceil(op.radius * 2);
    const srcX = Math.max(0, Math.floor(rect.x - padding));
    const srcY = Math.max(0, Math.floor(rect.y - padding));
    const srcWidth = Math.min(ctx.canvas.width - srcX, Math.ceil(rect.width + padding * 2));
    const srcHeight = Math.min(ctx.canvas.height - srcY, Math.ceil(rect.height + padding * 2));
    if (srcWidth < 1 || srcHeight < 1) {
      ctx.restore();
      return;
    }
    const snapshot = document.createElement('canvas');
    snapshot.width = srcWidth;
    snapshot.height = srcHeight;
    const snapshotCtx = snapshot.getContext('2d');
    if (!snapshotCtx) {
      ctx.restore();
      return;
    }
    snapshotCtx.drawImage(ctx.canvas, srcX, srcY, srcWidth, srcHeight, 0, 0, srcWidth, srcHeight);
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.filter = `blur(${op.radius}px)`;
    ctx.drawImage(snapshot, srcX, srcY);
    ctx.filter = 'none';
  } else {
    ctx.font = `700 ${op.fontSize}px Arial, sans-serif`;
    ctx.lineWidth = Math.max(3, Math.round(op.fontSize / 9));
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(op.text, op.at.x, op.at.y);
    ctx.fillStyle = op.color;
    ctx.fillText(op.text, op.at.x, op.at.y);
  }
  ctx.restore();
};

const annotationBounds = (ctx: CanvasRenderingContext2D, op: AnnotationOp): Bounds => {
  if (op.type === 'pen') {
    const padding = op.width + 8;
    const xs = op.points.map((point) => point.x);
    const ys = op.points.map((point) => point.y);
    return {
      x: Math.min(...xs) - padding,
      y: Math.min(...ys) - padding,
      width: Math.max(...xs) - Math.min(...xs) + padding * 2,
      height: Math.max(...ys) - Math.min(...ys) + padding * 2,
    };
  }
  if (op.type === 'arrow') {
    const padding = op.width + 18;
    return {
      x: Math.min(op.from.x, op.to.x) - padding,
      y: Math.min(op.from.y, op.to.y) - padding,
      width: Math.abs(op.to.x - op.from.x) + padding * 2,
      height: Math.abs(op.to.y - op.from.y) + padding * 2,
    };
  }
  if (op.type === 'rect' || op.type === 'blur') {
    const rect = normalizeRect(op.from, op.to);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  ctx.font = `700 ${op.fontSize}px Arial, sans-serif`;
  return {
    x: op.at.x - 8,
    y: op.at.y - op.fontSize * 1.15,
    width: ctx.measureText(op.text).width + 16,
    height: op.fontSize * 1.35,
  };
};

const hitAnnotation = (ctx: CanvasRenderingContext2D, point: Point, op: AnnotationOp) => {
  if (op.type === 'arrow') {
    return pointToSegmentDistance(point, op.from, op.to) <= Math.max(12, op.width + 7);
  }
  if (op.type === 'pen') {
    if (op.points.length < 2) return false;
    return op.points.some((linePoint, index) => {
      const previous = op.points[index - 1];
      return previous ? pointToSegmentDistance(point, previous, linePoint) <= Math.max(10, op.width + 6) : false;
    });
  }
  const bounds = annotationBounds(ctx, op);
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
};

const selectionBounds = (ctx: CanvasRenderingContext2D, op: AnnotationOp): Bounds => {
  const bounds = annotationBounds(ctx, op);
  return {
    x: bounds.x - SELECTION_PADDING,
    y: bounds.y - SELECTION_PADDING,
    width: bounds.width + SELECTION_PADDING * 2,
    height: bounds.height + SELECTION_PADDING * 2,
  };
};

const resizeHandleSize = (ctx: CanvasRenderingContext2D): number =>
  Math.max(12, Math.min(24, ctx.canvas.width / 90));

const resizeHandlesForBounds = (bounds: Bounds): Array<{ handle: ResizeHandle; x: number; y: number }> => {
  const midX = bounds.x + bounds.width / 2;
  const midY = bounds.y + bounds.height / 2;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  return [
    { handle: 'nw', x: bounds.x, y: bounds.y },
    { handle: 'n', x: midX, y: bounds.y },
    { handle: 'ne', x: right, y: bounds.y },
    { handle: 'e', x: right, y: midY },
    { handle: 'se', x: right, y: bottom },
    { handle: 's', x: midX, y: bottom },
    { handle: 'sw', x: bounds.x, y: bottom },
    { handle: 'w', x: bounds.x, y: midY },
  ];
};

const hitResizeHandle = (ctx: CanvasRenderingContext2D, point: Point, op: AnnotationOp): ResizeHandle | null => {
  const bounds = selectionBounds(ctx, op);
  const hitSize = resizeHandleSize(ctx) * 1.6;
  for (const item of resizeHandlesForBounds(bounds)) {
    if (Math.abs(point.x - item.x) <= hitSize / 2 && Math.abs(point.y - item.y) <= hitSize / 2) {
      return item.handle;
    }
  }
  return null;
};

const drawSelectionOutline = (ctx: CanvasRenderingContext2D, op: AnnotationOp) => {
  const bounds = selectionBounds(ctx, op);
  const handleSize = resizeHandleSize(ctx);
  ctx.save();
  ctx.lineWidth = Math.max(2, Math.min(5, ctx.canvas.width / 420));
  ctx.setLineDash([10, 7]);
  ctx.strokeStyle = 'rgba(80, 164, 255, 0.95)';
  ctx.shadowColor = 'rgba(80, 164, 255, 0.55)';
  ctx.shadowBlur = 10;
  ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.setLineDash([]);
  ctx.shadowBlur = 8;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(30, 100, 183, 0.95)';
  ctx.lineWidth = Math.max(2, handleSize / 7);
  resizeHandlesForBounds(bounds).forEach((handle) => {
    ctx.beginPath();
    ctx.rect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
};

const resizeBoundsForHandle = (bounds: Bounds, handle: ResizeHandle, dx: number, dy: number): Bounds => {
  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y + bounds.height;
  const minSize = 6;

  if (handle.includes('w')) left += dx;
  if (handle.includes('e')) right += dx;
  if (handle.includes('n')) top += dy;
  if (handle.includes('s')) bottom += dy;

  if (right - left < minSize) {
    if (handle.includes('w')) left = right - minSize;
    else right = left + minSize;
  }
  if (bottom - top < minSize) {
    if (handle.includes('n')) top = bottom - minSize;
    else bottom = top + minSize;
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
};

const scaleAnnotationToBounds = (op: AnnotationOp, originalBounds: Bounds, nextBounds: Bounds): AnnotationOp => {
  const scaleX = originalBounds.width === 0 ? 1 : nextBounds.width / originalBounds.width;
  const scaleY = originalBounds.height === 0 ? 1 : nextBounds.height / originalBounds.height;
  const strokeScale = Math.max(0.2, (Math.abs(scaleX) + Math.abs(scaleY)) / 2);
  const fontScale = Math.max(0.2, Math.max(Math.abs(scaleX), Math.abs(scaleY)));
  const mapPoint = (point: Point) => ({
    x: nextBounds.x + (point.x - originalBounds.x) * scaleX,
    y: nextBounds.y + (point.y - originalBounds.y) * scaleY,
  });

  if (op.type === 'pen') {
    return { ...op, points: op.points.map(mapPoint), width: Math.max(1, op.width * strokeScale) };
  }
  if (op.type === 'arrow') {
    return { ...op, from: mapPoint(op.from), to: mapPoint(op.to), width: Math.max(1, op.width * strokeScale) };
  }
  if (op.type === 'rect') {
    return { ...op, from: mapPoint(op.from), to: mapPoint(op.to), width: Math.max(1, op.width * strokeScale) };
  }
  if (op.type === 'blur') {
    return { ...op, from: mapPoint(op.from), to: mapPoint(op.to), radius: Math.max(2, op.radius * strokeScale) };
  }
  return { ...op, at: mapPoint(op.at), fontSize: Math.max(8, op.fontSize * fontScale) };
};

const stripPngDataUrl = (dataUrl: string): string => dataUrl.replace(/^data:image\/png;base64,/, '');

// toBlob keeps the PNG encode of a full-resolution capture off the main
// thread, unlike the synchronous toDataURL.
const canvasToPngBase64 = (canvas: HTMLCanvasElement): Promise<string> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not encode the edited image'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(stripPngDataUrl(String(reader.result)));
      reader.onerror = () => reject(new Error('Could not encode the edited image'));
      reader.readAsDataURL(blob);
    }, 'image/png');
  });

export const AnnotationEditor = ({
  imageBase64,
  title,
  replaceDefault = true,
  onClose,
  onSave,
}: AnnotationEditorProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const activePathRef = useRef<AnnotationOp | null>(null);
  const moveStateRef = useRef<MoveState | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const sizeChangePreviousOpsRef = useRef<AnnotationOp[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<AnnotationTool>('select');
  const [color, setColor] = useState('#ff2c22');
  const [strokeWidth, setStrokeWidth] = useState(9);
  const [replace, setReplace] = useState(replaceDefault);
  const [annotationState, setAnnotationState] = useState<AnnotationHistory>({ ops: [], history: [], future: [] });
  const ops = annotationState.ops;
  const [draft, setDraft] = useState<AnnotationOp | null>(null);
  const [editingText, setEditingText] = useState<EditingText | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const selectedOp = selectedIndex !== null ? ops[selectedIndex] : null;
  const selectedSize = selectedOp ? annotationSizeValue(selectedOp) : strokeWidth;
  const canAdjustSelectedSize = tool === 'select' && selectedOp !== null && !editingText;

  const render = useCallback((nextOps: AnnotationOp[], nextDraft: AnnotationOp | null, nextSelectedIndex: number | null = null) => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Assigning width/height clears the bitmap and resets context state even
    // for the same value, so only do it when the size actually changed.
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    nextOps.forEach((op) => drawAnnotation(ctx, op));
    if (nextDraft) drawAnnotation(ctx, nextDraft);
    if (nextSelectedIndex !== null && nextOps[nextSelectedIndex]) {
      drawSelectionOutline(ctx, nextOps[nextSelectedIndex]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setAnnotationState({ ops: [], history: [], future: [] });
    setDraft(null);
    setSelectedIndex(null);
    const img = new window.Image();
    img.onload = () => {
      if (!alive) return;
      imgRef.current = img;
      setLoading(false);
      window.requestAnimationFrame(() => render([], null));
    };
    img.onerror = () => {
      if (!alive) return;
      setLoading(false);
      setError('Failed to load capture image');
    };
    img.src = `data:image/png;base64,${imageBase64}`;
    return () => {
      alive = false;
    };
  }, [imageBase64, render]);

  useEffect(() => {
    const visibleOps =
      editingText && editingText.opIndex !== null
        ? ops.filter((_, index) => index !== editingText.opIndex)
        : ops;
    render(visibleOps, draft, editingText ? null : selectedIndex);
  }, [draft, editingText, ops, render, selectedIndex]);

  useEffect(() => {
    if (!editingText) return undefined;
    const id = window.setTimeout(() => {
      textInputRef.current?.focus();
      textInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [editingText?.opIndex, editingText?.left, editingText?.top]);

  const canvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const textPlacement = useCallback((point: Point) => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return { left: 0, top: 0, scale: 1 };
    const canvasRect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const scaleX = canvasRect.width / Math.max(1, canvas.width);
    const scaleY = canvasRect.height / Math.max(1, canvas.height);
    return {
      left: canvasRect.left - stageRect.left + point.x * scaleX,
      top: canvasRect.top - stageRect.top + point.y * scaleY,
      scale: Math.min(scaleX, scaleY),
    };
  }, []);

  const textHitIndex = useCallback(
    (point: Point, sourceOps: AnnotationOp[] = ops) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!ctx) return -1;
      for (let index = sourceOps.length - 1; index >= 0; index -= 1) {
        const op = sourceOps[index];
        if (op.type !== 'text') continue;
        ctx.font = `700 ${op.fontSize}px Arial, sans-serif`;
        const width = ctx.measureText(op.text).width;
        const height = op.fontSize * 1.25;
        if (
          point.x >= op.at.x - 10 &&
          point.x <= op.at.x + width + 10 &&
          point.y >= op.at.y - height &&
          point.y <= op.at.y + 12
        ) {
          return index;
        }
      }
      return -1;
    },
    [ops]
  );

  const annotationHitIndex = useCallback(
    (point: Point, sourceOps: AnnotationOp[] = ops) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!ctx) return -1;
      for (let index = sourceOps.length - 1; index >= 0; index -= 1) {
        if (hitAnnotation(ctx, point, sourceOps[index])) return index;
      }
      return -1;
    },
    [ops]
  );

  const startTextEdit = useCallback(
    (point: Point, opIndex: number | null, sourceOps: AnnotationOp[] = ops) => {
      const existing = opIndex !== null ? sourceOps[opIndex] : null;
      const textOp = existing?.type === 'text' ? existing : null;
      const nextAt = textOp?.at ?? point;
      const placement = textPlacement(nextAt);
      const nextFontSize = textOp?.fontSize ?? Math.max(18, strokeWidth * 4);
      if (textOp) {
        setColor(textOp.color);
        setStrokeWidth(Math.max(3, Math.min(30, Math.round(textOp.fontSize / 4))));
      }
      setEditingText({
        opIndex,
        at: nextAt,
        text: textOp?.text ?? '',
        color: textOp?.color ?? color,
        fontSize: nextFontSize,
        ...placement,
      });
    },
    [color, ops, strokeWidth, textPlacement]
  );

  const commitTextEdit = useCallback(
    (sourceOps: AnnotationOp[] = ops) => {
      if (!editingText) return sourceOps;
      const text = editingText.text.trim();
      let nextOps = sourceOps;
      if (editingText.opIndex !== null) {
        const existing = sourceOps[editingText.opIndex];
        const unchanged =
          existing?.type === 'text' &&
          existing.text === text &&
          existing.at === editingText.at &&
          existing.color === editingText.color &&
          existing.fontSize === editingText.fontSize;
        if (!unchanged) {
          nextOps = text
            ? sourceOps.map((op, index) =>
                index === editingText.opIndex
                  ? { type: 'text', at: editingText.at, text, color: editingText.color, fontSize: editingText.fontSize }
                  : op
              )
            : sourceOps.filter((_, index) => index !== editingText.opIndex);
        }
      } else if (text) {
        nextOps = [
          ...sourceOps,
          { type: 'text', at: editingText.at, text, color: editingText.color, fontSize: editingText.fontSize },
        ];
      }
      if (nextOps !== sourceOps) {
        setAnnotationState((current) => ({
          ops: nextOps,
          history: [...current.history, sourceOps].slice(-HISTORY_LIMIT),
          future: [],
        }));
      }
      setEditingText(null);
      if (editingText.opIndex !== null) {
        setSelectedIndex(text ? editingText.opIndex : null);
      } else if (text) {
        setSelectedIndex(nextOps.length - 1);
      }
      return nextOps;
    },
    [editingText, ops]
  );

  const updateColor = (nextColor: string) => {
    setColor(nextColor);
    setEditingText((current) => (current ? { ...current, color: nextColor } : current));
  };

  const beginSelectedSizeChange = () => {
    if (!canAdjustSelectedSize) return;
    sizeChangePreviousOpsRef.current = ops;
  };

  const updateSelectedSize = (nextWidth: number) => {
    if (!canAdjustSelectedSize || selectedIndex === null) return;
    const nextSize = clampAnnotationSize(nextWidth);
    if (!sizeChangePreviousOpsRef.current) sizeChangePreviousOpsRef.current = ops;
    setAnnotationState((current) => {
      const target = current.ops[selectedIndex];
      if (!target || annotationSizeValue(target) === nextSize) return current;
      return {
        ...current,
        ops: current.ops.map((op, index) => (index === selectedIndex ? annotationWithSize(op, nextSize) : op)),
        future: [],
      };
    });
  };

  const finishSelectedSizeChange = () => {
    const previousOps = sizeChangePreviousOpsRef.current;
    sizeChangePreviousOpsRef.current = null;
    if (!previousOps) return;
    setAnnotationState((current) => {
      if (current.ops === previousOps) return current;
      return {
        ops: current.ops,
        history: [...current.history, previousOps].slice(-HISTORY_LIMIT),
        future: [],
      };
    });
  };

  const begin = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!imgRef.current) return;
    if (!event.isPrimary || event.button !== 0) return;
    const point = canvasPoint(event);
    if (tool === 'select') {
      event.preventDefault();
      const workingOps = commitTextEdit();
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      const selectedHandleIndex = selectedIndex;
      const selectedOp = selectedHandleIndex !== null ? workingOps[selectedHandleIndex] : null;
      if (ctx && selectedHandleIndex !== null && selectedOp) {
        const handle = hitResizeHandle(ctx, point, selectedOp);
        if (handle) {
          resizeStateRef.current = {
            index: selectedHandleIndex,
            handle,
            start: point,
            original: selectedOp,
            originalBounds: annotationBounds(ctx, selectedOp),
            previousOps: workingOps,
            changed: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
      }
      const hitIndex = annotationHitIndex(point, workingOps);
      setSelectedIndex(hitIndex >= 0 ? hitIndex : null);
      if (hitIndex >= 0) {
        moveStateRef.current = {
          index: hitIndex,
          start: point,
          original: workingOps[hitIndex],
          previousOps: workingOps,
          changed: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (tool === 'text') {
      event.preventDefault();
      const workingOps = commitTextEdit();
      const hitIndex = textHitIndex(point, workingOps);
      setSelectedIndex(hitIndex >= 0 ? hitIndex : null);
      startTextEdit(point, hitIndex >= 0 ? hitIndex : null, workingOps);
      return;
    }
    commitTextEdit();
    setSelectedIndex(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    const base =
      tool === 'pen'
        ? ({ type: 'pen', points: [point], color, width: strokeWidth } satisfies AnnotationOp)
        : tool === 'arrow'
          ? ({ type: 'arrow', from: point, to: point, color, width: strokeWidth } satisfies AnnotationOp)
          : tool === 'blur'
            ? ({ type: 'blur', from: point, to: point, radius: Math.max(8, strokeWidth * 2) } satisfies AnnotationOp)
            : ({ type: 'rect', from: point, to: point, color, width: strokeWidth } satisfies AnnotationOp);
    activePathRef.current = base;
    setDraft(base);
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!event.isPrimary) return;
    const resizeState = resizeStateRef.current;
    if (resizeState) {
      const point = canvasPoint(event);
      const nextBounds = resizeBoundsForHandle(
        resizeState.originalBounds,
        resizeState.handle,
        point.x - resizeState.start.x,
        point.y - resizeState.start.y
      );
      const next = scaleAnnotationToBounds(resizeState.original, resizeState.originalBounds, nextBounds);
      resizeState.changed = true;
      setAnnotationState((current) => ({
        ...current,
        ops: current.ops.map((op, index) => (index === resizeState.index ? next : op)),
      }));
      return;
    }
    const moveState = moveStateRef.current;
    if (moveState) {
      const point = canvasPoint(event);
      const next = translateAnnotation(moveState.original, point.x - moveState.start.x, point.y - moveState.start.y);
      moveState.changed = true;
      setAnnotationState((current) => ({
        ...current,
        ops: current.ops.map((op, index) => (index === moveState.index ? next : op)),
      }));
      return;
    }
    const active = activePathRef.current;
    if (!active) return;
    const point = canvasPoint(event);
    const next =
      active.type === 'pen'
        ? { ...active, points: [...active.points, point] }
        : active.type === 'arrow'
          ? { ...active, to: point }
          : { ...active, to: point };
    activePathRef.current = next;
    setDraft(next);
  };

  const pushGestureHistory = (previousOps: AnnotationOp[]) => {
    setAnnotationState((current) => ({
      ops: current.ops,
      history: [...current.history, previousOps].slice(-HISTORY_LIMIT),
      future: [],
    }));
  };

  const finish = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!event.isPrimary) return;
    const resizeState = resizeStateRef.current;
    if (resizeState) {
      resizeStateRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture can already be released when a drag leaves the window.
      }
      if (resizeState.changed) pushGestureHistory(resizeState.previousOps);
      return;
    }
    const moveState = moveStateRef.current;
    if (moveState) {
      moveStateRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Selection clicks do not always establish pointer capture.
      }
      if (moveState.changed) pushGestureHistory(moveState.previousOps);
      return;
    }
    const active = activePathRef.current;
    if (!active) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The text tool does not capture the pointer.
    }
    activePathRef.current = null;
    setDraft(null);
    if (active.type === 'pen' && active.points.length < 2) return;
    if (active.type === 'arrow' && Math.hypot(active.to.x - active.from.x, active.to.y - active.from.y) < 4) return;
    if ((active.type === 'rect' || active.type === 'blur') && normalizeRect(active.from, active.to).width < 4) return;
    if ((active.type === 'rect' || active.type === 'blur') && normalizeRect(active.from, active.to).height < 4) return;
    setSelectedIndex(ops.length);
    setAnnotationState((current) => ({
      ops: [...current.ops, active],
      history: [...current.history, current.ops].slice(-HISTORY_LIMIT),
      future: [],
    }));
  };

  const undo = () => {
    if (editingText) commitTextEdit();
    setSelectedIndex(null);
    setAnnotationState((current) => {
      if (current.history.length === 0) return current;
      return {
        ops: current.history[current.history.length - 1],
        history: current.history.slice(0, -1),
        future: [current.ops, ...current.future].slice(0, HISTORY_LIMIT),
      };
    });
  };

  const redo = () => {
    if (editingText) commitTextEdit();
    setSelectedIndex(null);
    setAnnotationState((current) => {
      if (current.future.length === 0) return current;
      const [head, ...tail] = current.future;
      return {
        ops: head,
        history: [...current.history, current.ops].slice(-HISTORY_LIMIT),
        future: tail,
      };
    });
  };

  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    setError(null);
    try {
      const finalOps = commitTextEdit();
      render(finalOps, null);
      await onSave({
        pngBase64: await canvasToPngBase64(canvas),
        replace,
        operationCount: finalOps.length,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save edit');
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  const hasSaveableOps = ops.length > 0 || Boolean(editingText?.text.trim());

  return (
    <div
      className="dc-annotation-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={() => {
        // A stray backdrop click must not silently discard unsaved work;
        // the close button stays as the explicit way out.
        if (!hasSaveableOps) onClose();
      }}
    >
      <div className="dc-annotation-editor" onClick={(event) => event.stopPropagation()}>
        <div className="dc-annotation-toolbar">
          <div className="dc-annotation-title" title={title}>{title}</div>
          <div className="dc-annotation-tool-group">
            {([
              ['select', MousePointer2, 'Select'],
              ['pen', Pencil, 'Draw'],
              ['arrow', ArrowUpRight, 'Arrow'],
              ['rect', Square, 'Box'],
              ['blur', Droplets, 'Blur'],
              ['text', Type, 'Text'],
            ] as const).map(([key, Icon, label]) => (
              <button
                key={key}
                type="button"
                className={tool === key ? 'active' : ''}
                onClick={() => {
                  if (tool === 'text' && key !== 'text') commitTextEdit();
                  if (key !== 'select') setSelectedIndex(null);
                  setTool(key);
                }}
                title={label}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <label className="dc-annotation-color">
            <input type="color" value={color} onChange={(event) => updateColor(event.target.value)} />
            <span>{color}</span>
          </label>
          <label
            className={`dc-annotation-range${canAdjustSelectedSize ? '' : ' disabled'}`}
            title={canAdjustSelectedSize ? 'Resize selected annotation' : 'Select an annotation to resize it'}
          >
            <span>Size</span>
            <input
              type="range"
              min={3}
              max={30}
              value={selectedSize}
              disabled={!canAdjustSelectedSize}
              onPointerDown={beginSelectedSizeChange}
              onPointerUp={finishSelectedSizeChange}
              onPointerCancel={finishSelectedSizeChange}
              onBlur={finishSelectedSizeChange}
              onKeyUp={finishSelectedSizeChange}
              onChange={(event) => updateSelectedSize(Number(event.target.value))}
            />
          </label>
          <span className="dc-annotation-spacer" />
          <button type="button" onClick={undo} disabled={annotationState.history.length === 0 && !editingText}>
            <Eraser size={16} />
            <span>Undo</span>
          </button>
          <button type="button" onClick={redo} disabled={annotationState.future.length === 0}>
            <Redo2 size={16} />
            <span>Redo</span>
          </button>
          <label className="dc-annotation-replace">
            <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
            <span>Replace current image</span>
          </label>
          <button type="button" className="dc-btn primary" onClick={() => void save()} disabled={saving || loading || !hasSaveableOps}>
            <Check size={16} />
            <span>{saving ? 'Saving...' : replace ? 'Save changes' : 'Save as new image'}</span>
          </button>
          <button type="button" className="dc-annotation-icon" onClick={onClose} aria-label="Close editor">
            <X size={16} />
          </button>
        </div>
        <div className="dc-annotation-stage" ref={stageRef}>
          {loading ? <div className="dc-annotation-message">Loading capture...</div> : null}
          {error ? <div className="dc-annotation-error">{error}</div> : null}
          <canvas
            ref={canvasRef}
            className={`dc-annotation-canvas ${tool === 'select' ? 'is-selecting' : ''}`}
            onPointerDown={begin}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={finish}
          />
          {editingText && (
            <textarea
              ref={textInputRef}
              className="dc-annotation-text"
              value={editingText.text}
              placeholder="Type here"
              style={{
                left: editingText.left,
                top: editingText.top - editingText.fontSize * editingText.scale,
                color: editingText.color,
                fontSize: Math.max(14, editingText.fontSize * editingText.scale),
              }}
              onChange={(event) =>
                setEditingText((current) => (current ? { ...current, text: event.target.value } : current))
              }
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditingText(null);
                } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  commitTextEdit();
                }
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};
