const RequestStatus = {
  OK: '1',
  KO: '0'
}

const VerificationStatus = {
  FAILED: 'Fail - Unable to verify',
  NOT_VERIFIED: 'Fail - Unable to verify',
  SUCCESS: 'Pass - Verified',
  PENDING: 'Pending in queue',
  ALREADY_VERIFIED: 'Contract source code already verified',
  NOT_DEPLOYED: 'Contract not deployed in the network'
}

module.exports = {
  RequestStatus,
  VerificationStatus
}
