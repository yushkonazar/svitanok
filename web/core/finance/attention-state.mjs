/** Allowlisted owner response; never forward arbitrary bank JSON to a model.
 * @param {unknown} rawJson
 * @returns {{status:'reviewing'|'different',at:string,source:'owner'}|null} */
export function parseFinanceAttention(rawJson) {
  try {
    const value = JSON.parse(String(rawJson ?? '{}')).financeAttention;
    if (
      value?.source !== 'owner' ||
      !['reviewing', 'different'].includes(value.status) ||
      typeof value.at !== 'string' ||
      !Number.isFinite(Date.parse(value.at))
    )
      return null;
    return { status: value.status, at: value.at, source: 'owner' };
  } catch {
    return null;
  }
}
