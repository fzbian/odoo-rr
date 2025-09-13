import axios from 'axios';

export async function getLocations() {
  const { data } = await axios.get('/api/locations');
  return data;
}

export async function searchProducts(q) {
  const { data } = await axios.get('/api/products', { params: { q } });
  return data;
}

export async function createTransfer({ originLocationId, destLocationId, lines, notes }) {
  const { data } = await axios.post('/api/transfer', { originLocationId, destLocationId, lines, notes });
  return data;
}
