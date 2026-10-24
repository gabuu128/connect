export function createNetworkAdapter(mode) {
  if (mode === 'demo') {
    return {
      mode,
      label: 'Simulated network',
      simulated: true,
      enforceAccess: () => ({ enforced: true, simulated: true }),
    };
  }

  return {
    mode: 'production',
    label: 'No provider adapter configured',
    simulated: false,
    enforceAccess: () => {
      const error = new Error('Provider network adapter is not configured');
      error.status = 503;
      throw error;
    },
  };
}