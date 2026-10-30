// Only the satellite.js functions SatRadar uses (deep imports skip the WASM part,
// which pulls in Node-only modules and is not needed in the browser).
export { json2satrec } from '../node_modules/satellite.js/dist/io.js';
export { propagate, gstime } from '../node_modules/satellite.js/dist/propagation.js';
export {
  eciToGeodetic, eciToEcf, ecfToLookAngles, degreesLat, degreesLong, degreesToRadians,
} from '../node_modules/satellite.js/dist/transforms.js';
