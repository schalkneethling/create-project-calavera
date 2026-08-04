export const releaseEnvironmentInputSchema = {
  oneOf: [
    { const: false },
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["reviewers"],
      properties: {
        name: { type: "string" },
        reviewers: { type: "array", items: { type: "string" } },
        waitTimer: { type: "integer", minimum: 0, maximum: 43200 },
        preventSelfReview: { type: "boolean" },
        branches: { type: "array", items: { type: "string" } },
      },
    },
  ],
};
