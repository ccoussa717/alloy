export function loadRecord(records, tenantId, recordId) {
  return records.find((record) => record.id === recordId && record.tenantId === tenantId) ?? null;
}
