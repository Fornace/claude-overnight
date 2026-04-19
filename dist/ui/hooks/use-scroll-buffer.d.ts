export interface ScrollBufferResult<T> {
    viewportItems: T[];
    scrollOffset: number;
    isFollowing: boolean;
    handleKeyDown: (e: {
        key: string;
    }) => void;
}
export declare function useScrollBuffer<T>(items: T[], visibleCount: number): ScrollBufferResult<T>;
