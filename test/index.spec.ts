import { stitch } from "../src/index.ts";

import { fetchAdapter, axiosAdapter } from "../src/adapters";

describe("imports", () => {
  it("Should import from index.ts", async () => {
    expect(stitch).toBeDefined();
    expect(fetchAdapter).toBeDefined();
    expect(axiosAdapter).toBeDefined();
  });
});
