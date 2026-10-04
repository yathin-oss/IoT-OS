import { useRef, useState } from 'react';

/** Drag handle reporting incremental pixel deltas. */
export function Splitter({ direction, onDrag }: { direction: 'v' | 'h'; onDrag: (delta: number) => void }) {
  const last = useRef(0);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`splitter-${direction}${dragging ? ' dragging' : ''}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = direction === 'v' ? e.clientX : e.clientY;
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const pos = direction === 'v' ? e.clientX : e.clientY;
        const d = pos - last.current;
        if (d !== 0) {
          last.current = pos;
          onDrag(d);
        }
      }}
      onPointerUp={() => setDragging(false)}
    />
  );
}
