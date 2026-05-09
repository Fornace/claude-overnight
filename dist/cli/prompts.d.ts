export declare const PASTE_PLACEHOLDER_MAX = 80;
/**
 * Read a line from the user with bracketed-paste awareness. Pasted multi-line
 * text stays in the buffer as a single block — only a typed Enter submits.
 * Falls back to cooked readline when stdin isn't a TTY.
 */
export declare function ask(question: string): Promise<string>;
export declare function select<T>(label: string, items: {
    name: string;
    value: T;
    hint?: string;
}[], defaultIdx?: number): Promise<T>;
export declare function selectKey(label: string, options: {
    key: string;
    desc: string;
}[]): Promise<string>;
