declare module "shapefile" {
  interface Source {
    read(): Promise<{ done: boolean; value: any }>;
  }
  function open(shp: string, dbf?: string, options?: any): Promise<Source>;
  export default { open };
}
