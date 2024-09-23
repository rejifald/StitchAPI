import { GetResponseType } from '@/types/get-response-type';
import { StitchConfig } from '@/types/stitch';

interface ErrorContext<TOptions> {
    config: StitchConfig<GetResponseType<TOptions>>;
    original?: unknown;
}

export class StitchError<TOptions> extends Error {
    public readonly config: StitchConfig<GetResponseType<TOptions>>;
    public readonly original?: unknown;
    constructor(message: string, { config, original }: ErrorContext<TOptions>) {
        super(message);
        this.config = config;
        this.original = original;
        this.name = 'StitchError';
    }
}
