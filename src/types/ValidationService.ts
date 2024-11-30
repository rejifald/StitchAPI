interface ValidationService<TSchema = unknown, TData = unknown> {
    validate(schema: TSchema, data: unknown): TData;
}
