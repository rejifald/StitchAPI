export type AdapterInput = {
    url: string;
    method: string;
    body?: unknown;
};

export type Adapter = (input: AdapterInput) => Promise<unknown>;
