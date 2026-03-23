import shapefile from "shapefile";

async function main() {
  const source = await shapefile.open(
    "./data/SHP/R11_21_WGS84.shp",
    "./data/SHP/R11_21_WGS84.dbf"
  );

  let count = 0;
  let sample: any = null;
  let anCount = 0;

  while (true) {
    const { done, value } = await source.read();
    if (done) break;
    count++;
    if (count === 1) {
      sample = value;
    }
    // Check if PRO_COM starts with 42 (provincia Ancona)
    const procom = String(value.properties?.PRO_COM ?? "");
    if (procom.startsWith("42")) anCount++;
  }

  console.log("Total features:", count);
  console.log("AN features:", anCount);
  console.log("Sample properties:", JSON.stringify(sample.properties, null, 2));
  console.log("Geometry type:", sample.geometry.type);

  // Show first coordinate
  const coords = sample.geometry.coordinates;
  if (sample.geometry.type === "Polygon") {
    console.log("First coord (UTM):", coords[0][0]);
  } else if (sample.geometry.type === "MultiPolygon") {
    console.log("First coord (UTM):", coords[0][0][0]);
  }
}

main().catch(console.error);
