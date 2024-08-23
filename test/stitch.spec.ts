import { stitch } from "../src/stitch";
import { fetch } from "./__mocks__/fetch";

describe("stitch", () => {
  it("Should return stitched function with method", async () => {
    const stitched = stitch({
      path: "https://reqres.in/api/users/{id}",
      method: "PATCH",
    });
    expect(stitched).toBeInstanceOf(Function);

    await stitched({
      params: { id: "2" },
      body: {
        name: "morpheus",
        job: "zion resident",
      },
    });

    expect(fetch).toHaveBeenCalledWith("https://reqres.in/api/users/2", {
      method: "PATCH",
      body: JSON.stringify({
        name: "morpheus",
        job: "zion resident",
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
  });
});
