export class RequestService {
    public static async fetch<T>(
        url: string,
        options: RequestInit,
    ): Promise<T> {
        const response = await fetch(url, options);
        return response.json();
    }
}
