/**
 * The slice of Bunny's edge-script SDK this repository uses. The runtime
 * provides the module; it is kept external in the bundle (see `pnpm build`).
 */
export declare const net: {
  http: {
    serve(handler: (request: Request) => Promise<Response> | Response): void;
  };
};
