import { stitch } from "../src";
import { fetch } from "./__mocks__/fetch";

describe("url templates", () => {
  beforeEach(() => {
    fetch.mockClear();
  });

  it("Should resolve url template", () => {
    stitch({ path: "https://reqres.in/api/users/{id}" })({
      params: { id: 1 },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://reqres.in/api/users/1", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
  });
});
