// Minimal `react-native` stub so the lifecycle module imports cleanly under vitest
// (node). Tests inject their own AppState/NetInfo, so this only needs to exist —
// it is never the thing under test.
export const AppState = {
    currentState: 'active' as string,
    addEventListener(
        _type: 'change',
        _listener: (state: string) => void,
    ): { remove(): void } {
        return { remove() {} };
    },
};
