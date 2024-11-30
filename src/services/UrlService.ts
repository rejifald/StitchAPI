import { ExtractRFCParams } from '../../lib/types/utils/get-template-type';

import { joinURL } from 'ufo';
import { Template, parseTemplate } from 'url-template';

interface TemplateInput {
    baseUrl?: string;
    path: string;
}

export class UrlService {
    public static template(config: TemplateInput): Template {
        const path: string = joinURL(config.baseUrl ?? '', config.path);
        return parseTemplate(path);
    }

    public static extractRFCParams<T extends string>(
        template: T,
    ): ExtractRFCParams<T>[] {
        const regex = /{(\+|#)?([^}]+)\*?}/g;
        const params = new Set<string>();
        let match: RegExpExecArray | null;

        while ((match = regex.exec(template)) !== null) {
            params.add(match[2]);
        }

        return Array.from(params) as ExtractRFCParams<T>[];
    }

    // public static isTemplate(config: TemplateInput): boolean { };
}
