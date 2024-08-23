import { stitch } from "../src";
import { fetch } from "./__mocks__/fetch";

describe("url templates", () => {
  beforeEach(() => {
    fetch.mockClear();
  });

  it("Should resolve url template", () => {
    stitch({ path: "https://reqres.in/api/users/{id}" })({
      params: { id: "123" },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://reqres.in/api/users/123", {
      method: "GET",
      body: undefined,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
  });
});
