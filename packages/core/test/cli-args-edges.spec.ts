// argsToInput branches (src/cli.ts) the cli.spec.ts argsToInput block leaves open. It covers the
// full bucket names, coercion, whole-body JSON, repeated→array, and a query boolean; these pin:
//   - the SHORT/ALT bucket aliases (--q. / --H. / --param.) route like their full names;
//   - a boolean HEADER flag becomes the string 'true' (other buckets get the boolean true);
//   - the `positionals` return value collects every non-`--` token, in order.
import { argsToInput } from '../src/cli';

describe('argsToInput aliases + edges', () => {
    test('the --q. / --H. / --param. aliases route to query / headers / params', () => {
        const { input } = argsToInput([
            '--q.tag',
            'x',
            '--H.x-key',
            'v',
            '--param.id',
            '1',
        ]);
        expect(input.query).toEqual({ tag: 'x' });
        expect(input.headers).toEqual({ 'x-key': 'v' }); // header values stay raw strings
        expect(input.params).toEqual({ id: 1 }); // coerced
    });

    test('a boolean header flag is the string "true", not the boolean', () => {
        expect(argsToInput(['--header.x-flag']).input.headers).toEqual({
            'x-flag': 'true',
        });
        // contrast: a query boolean flag is the boolean true.
        expect(argsToInput(['--query.flag']).input.query).toEqual({
            flag: true,
        });
    });

    test('positionals collect every non-flag token in order', () => {
        const { input, positionals } = argsToInput(
            ['run', '--id', '7', 'extra'],
            ['id'],
        );
        expect(positionals).toEqual(['run', 'extra']);
        expect(input.params).toEqual({ id: 7 }); // --id routed to params (in the name set)
    });
});
