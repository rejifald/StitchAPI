import { axiosAdapter, fetchAdapter } from '../src/adapters';
import { stitch } from '../src/index.ts';

describe('imports', () => {
    it('Should import from index.ts', async () => {
        expect(stitch).toBeDefined();
        expect(fetchAdapter).toBeDefined();
        expect(axiosAdapter).toBeDefined();
    });
});
