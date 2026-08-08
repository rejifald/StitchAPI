// Type-level tests for the adapter capability hints (ADR 0005 Decision 9). The contract stays an
// open one-function seam: declaring capabilities is OPT-IN, so a plain `(req) => Promise<res>` must
// still satisfy `Adapter`. The built-ins resolve to `Adapter` and expose `capabilities` as an
// optional field.
import { axiosAdapter, fetchAdapter, xhrAdapter } from '../src';
import type {
    Adapter,
    AdapterCapabilities,
    AdapterCapability,
    AdapterRequest,
    AdapterResponse,
    AxiosLike,
} from '../src';

import axios from 'axios';
import { expectAssignable, expectError, expectType } from 'tsd';

// A plain transport function — no `capabilities` — still satisfies Adapter (backward compatible).
const plain = async (_req: AdapterRequest): Promise<AdapterResponse> => ({
    status: 200,
    headers: {},
    body: null,
});
expectAssignable<Adapter>(plain);

// An adapter MAY carry capabilities — a positive list of what it supports.
const caps: AdapterCapabilities = { name: 'x', supports: ['uploadProgress'] };
const withCaps: Adapter = Object.assign(plain, { capabilities: caps });
expectAssignable<Adapter>(withCaps);

// `capabilities` is an OPTIONAL field on the type (present-or-undefined).
expectType<AdapterCapabilities | undefined>(fetchAdapter().capabilities);

// Every built-in resolves to Adapter.
expectAssignable<Adapter>(fetchAdapter());
expectAssignable<Adapter>(xhrAdapter());

// The axios seam is structural, so any hand-rolled client that satisfies it is accepted...
const client = null as unknown as AxiosLike;
expectAssignable<Adapter>(axiosAdapter(client));

// ...but the assertion that matters is against REAL axios, because that is what the documented
// snippet passes. The `as unknown as AxiosLike` cast above cannot make it: it ASSERTS the client is
// an AxiosLike rather than testing whether axios actually is one, so #708 — `AxiosLikeConfig` being
// unassignable to axios's own `AxiosRequestConfig`, via a too-wide `responseType?: string` — passed
// this file while `axiosAdapter(axios)` failed to compile for every user. Pin all three call forms.
expectAssignable<Adapter>(axiosAdapter(axios));
expectAssignable<Adapter>(axiosAdapter(axios.create()));
expectAssignable<Adapter>(axiosAdapter(axios, { timeout: 5 }));

// `supports` is a list of the known capability tags; `name` is optional.
expectAssignable<AdapterCapabilities>({ supports: [] });
expectAssignable<AdapterCapabilities>({
    name: 'a',
    supports: ['stream', 'uploadProgress', 'downloadProgress'],
});
expectType<AdapterCapability[]>(fetchAdapter().capabilities!.supports);

// ...and typed: `supports` is required, and an unknown tag is rejected.
expectError<AdapterCapabilities>({ name: 'a' });
expectError<AdapterCapabilities>({ supports: ['teleport'] });
