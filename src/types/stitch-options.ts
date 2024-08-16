export interface StitchOptions {
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  unwrap?: string;
  baseUrl?: string;
}
