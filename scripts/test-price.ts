import 'dotenv/config';
import { fetchAndCachePrices } from '../src/lib/prices';

async function test() {
  const result = await fetchAndCachePrices(['HVO', 'UKW', 'TSLA']);
  console.log('Fetched result:', result);
}

test();
