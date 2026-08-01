import { stitch } from './src/index';
const a = stitch({ baseUrl:'https://x.dev', path:'/u', retry: { attempts: 3, on: [503], backoff: 'fixed', baseMs: 0 } });
const b = stitch({ baseUrl:'https://x.dev', path:'/u', retry: { attempts: 3, backoff: { curve:'fixed', base: 0 } } });
export { a, b };
