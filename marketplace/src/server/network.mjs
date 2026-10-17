export const GENESIS_HASHES=Object.freeze({
  'mainnet-beta':'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
});
export async function verifyNetwork(connection,cluster){
  const expected=GENESIS_HASHES[cluster];if(!expected)throw new Error('Unsupported network.');
  const genesisHash=await connection.getGenesisHash();
  if(genesisHash!==expected)throw new Error('RPC genesis does not match the configured Solana network. Server not started.');
  return genesisHash;
}
