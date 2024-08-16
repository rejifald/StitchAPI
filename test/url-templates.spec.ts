import { stitch } from "../src";
import { fetch } from "./__mocks__/fetch";

describe("url templates", () => {
  it("Should throw an error if path params are missing", async () => {
    await expect(
      stitch({ path: "https://reqres.in/api/users/{id}" }),
    ).rejects.toEqual(new Error("Missing path param: id"));
  });

  it("Should throw resolve url template", () => {
    stitch({ path: "https://reqres.in/api/users/{id}" })({
      params: { id: "123" },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://reqres.in/api/users/123", {
      method: "GET",
      body: undefined,
      headers: {
        "Content-Type": "application/json",
      },
    });
  });
});
