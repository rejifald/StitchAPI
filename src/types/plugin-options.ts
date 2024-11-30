import { RequireAtLeastOne } from 'type-fest';

type ValidationFn = <TContext>(value: unknown, context: TContext) => {};

type AssertationFn = <TContext>(value: unknown, context: TContext) => {};

type AssertationConfig =
    | RequireAtLeastOne<{
          response?: AssertationFn;
      }>
    | AssertationFn;

type ValidationConfig =
    | RequireAtLeastOne<{
          query?: ValidationFn;
          params?: ValidationFn;
          body?: ValidationFn;
          response?: ValidationFn;
      }>
    | ValidationFn;

type ConstructionConfig = {};

export type PluginOptions = {
    name?: string;
    construction?: ConstructionConfig;
    assertion?: AssertationConfig;
    validation?: ValidationConfig;
    lifecycle?: {
        onRequest?: () => {};
        onResponse?: () => {};
    };
};
