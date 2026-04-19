export type StreamViewMode = "events" | `stream:${string}`;
export interface StreamPaneProps {
    streamId?: string;
    agentId?: number;
    viewMode?: StreamViewMode;
    onViewModeChange?: (mode: StreamViewMode) => void;
}
export declare function StreamPane({ streamId, agentId, viewMode, onViewModeChange }: StreamPaneProps): import("react/jsx-runtime").JSX.Element;
