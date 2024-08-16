import { stitch } from "../src";
import { fetch } from "./__mocks__/fetch";

describe("qs", () => {
  it("Should return stitched function with query string", async () => {
    const stitched = stitch({
      path: "https://reqres.in/api/users/{id}",
      method: "PATCH",
    });
    expect(stitched).toBeInstanceOf(Function);

    await stitched({
      params: { id: "2" },
      query: {
        name: "morpheus",
        job: "zion resident",
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://reqres.in/api/users/2?name=morpheus&job=zion%20resident",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  });

  it("Should keep predefined query string", async () => {
    const stitched = stitch({
      path: "https://reqres.in/api/users/{id}?version=2",
      method: "PATCH",
    });
    expect(stitched).toBeInstanceOf(Function);

    await stitched({
      params: { id: "2" },
      query: {
        name: "morpheus",
        job: "zion resident",
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://reqres.in/api/users/2?version=2&name=morpheus&job=zion%20resident",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  });

  it("Should override conflicting query keys", async () => {
    const stitched = stitch({
      path: "https://reqres.in/api/users/{id}?type=admin",
      method: "PATCH",
    });
    expect(stitched).toBeInstanceOf(Function);

    await stitched({
      params: { id: "2" },
      query: {
        name: "morpheus",
        job: "zion resident",
        type: "user",
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://reqres.in/api/users/2?type=user&name=morpheus&job=zion%20resident",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  });
});
