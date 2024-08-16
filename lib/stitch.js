var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
import get from "lodash/get";
import intersection from "lodash/intersection";
import isEmpty from "lodash/isEmpty";
import qs from "qs";
import { joinURL, parseURL, stringifyParsedURL } from "ufo";
import { parseTemplate } from "url-template";
export const stitch = (options) => {
    const spec = typeof options === "string" ? { path: options, method: "GET" } : options;
    const placeholders = [...spec.path.matchAll(/{([^{}]+)}|([^{}]+)/g)]
        .map((match) => match[1])
        .filter(Boolean);
    const path = joinURL(get(options, "baseUrl", ""), spec.path);
    const urlTemplate = parseTemplate(path);
    return (...args_1) => __awaiter(void 0, [...args_1], void 0, function* ({ params = {}, query = {}, body = {}, fetchOptions = {}, } = {}) {
        let url;
        for (const placeholder of placeholders) {
            if (!params[placeholder]) {
                throw new Error(`Missing path param: ${placeholder}`);
            }
        }
        try {
            url = urlTemplate.expand(params);
        }
        catch (e) {
            throw new Error(`Failed to resolve url template. Reason: ${e.message}`);
        }
        if (!isEmpty(query)) {
            const _a = parseURL(url), { search } = _a, restUrlParts = __rest(_a, ["search"]);
            const predefinedQuery = qs.parse(search, {
                ignoreQueryPrefix: true,
            });
            const conflictedKeys = intersection(Object.keys(predefinedQuery), Object.keys(query));
            if (conflictedKeys.length) {
                console.warn("Conflicted query keys:", conflictedKeys.join(", "));
            }
            const combinedQuery = Object.assign(Object.assign({}, predefinedQuery), query);
            url = stringifyParsedURL(Object.assign(Object.assign({}, restUrlParts), { search: qs.stringify(combinedQuery, { addQueryPrefix: true }) }));
        }
        const response = yield fetch(url, Object.assign({ method: spec.method || "GET", body: isEmpty(body) ? undefined : JSON.stringify(body), headers: {
                "Content-Type": "application/json",
            } }, fetchOptions));
        const json = yield response.json();
        if (spec.unwrap) {
            return get(json, spec.unwrap);
        }
        return json;
    });
};
