// Minimal `react-native` stub so the @stitchapi/react-native lifecycle module
// (re-exported here) imports cleanly under vitest (node).
export const AppState = {
    currentState: 'active' as string,
    addEventListener(
        _type: 'change',
        _listener: (state: string) => void,
    ): { remove(): void } {
        return { remove() {} };
    },
};
