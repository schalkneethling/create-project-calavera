const NativeDate = globalThis.Date;
const futureDate = "2030-01-01T00:00:00.000Z";

globalThis.Date = class extends NativeDate {
  constructor(...arguments_) {
    super(...(arguments_.length > 0 ? arguments_ : [futureDate]));
  }

  static now() {
    return new NativeDate(futureDate).getTime();
  }
};
