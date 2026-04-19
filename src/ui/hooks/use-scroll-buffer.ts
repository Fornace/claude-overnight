import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ScrollBufferResult<T> {
  viewportItems: T[];
  scrollOffset: number;
  isFollowing: boolean;
  handleKeyDown: (e: { key: string }) => void;
}

export function useScrollBuffer<T>(items: T[], visibleCount: number): ScrollBufferResult<T> {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [isFollowing, setIsFollowing] = useState(true);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Auto-follow when new items arrive
  useEffect(() => {
    if (isFollowing) {
      setScrollOffset(Math.max(0, items.length - visibleCount));
    }
  }, [items.length, visibleCount, isFollowing]);

  const clamp = useCallback(
    (offset: number) => Math.max(0, Math.min(offset, Math.max(0, items.length - visibleCount))),
    [items.length, visibleCount],
  );

  const handleKeyDown = useCallback(
    (e: { key: string }) => {
      switch (e.key) {
        case "ArrowUp":
          setIsFollowing(false);
          setScrollOffset(prev => clamp(prev - 1));
          break;
        case "ArrowDown": {
          const maxOffset = Math.max(0, itemsRef.current.length - visibleCount);
          setScrollOffset(prev => {
            const next = clamp(prev + 1);
            if (next >= maxOffset) setIsFollowing(true);
            return next;
          });
          break;
        }
        case "PageUp":
          setIsFollowing(false);
          setScrollOffset(prev => clamp(prev - visibleCount));
          break;
        case "PageDown": {
          const maxOffset = Math.max(0, itemsRef.current.length - visibleCount);
          setScrollOffset(prev => {
            const next = clamp(prev + visibleCount);
            if (next >= maxOffset) setIsFollowing(true);
            return next;
          });
          break;
        }
        case "End":
        case "g":
          setIsFollowing(true);
          setScrollOffset(Math.max(0, itemsRef.current.length - visibleCount));
          break;
      }
    },
    [clamp, visibleCount],
  );

  const viewportItems = useMemo(
    () => items.slice(scrollOffset, scrollOffset + visibleCount),
    [items, scrollOffset, visibleCount],
  );

  return { viewportItems, scrollOffset, isFollowing, handleKeyDown };
}
