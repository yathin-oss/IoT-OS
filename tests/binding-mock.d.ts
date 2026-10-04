// The package ships types that its "exports" map hides from TypeScript's bundler
// resolution; declare the subset the tests use.
declare module '@serialport/binding-mock' {
  export interface CreatePortOptions {
    echo?: boolean;
    record?: boolean;
    readyData?: Buffer;
    manufacturer?: string;
    vendorId?: string;
    productId?: string;
  }
  export const MockBinding: {
    reset(): void;
    createPort(path: string, opt?: CreatePortOptions): void;
    list(): Promise<{ path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string }[]>;
  };
}
