const axios = require('axios')
const querystring = require('querystring')
const delay = require('delay')
const { merge } = require('sol-merger')
const fs = require('fs')
const { enforce, enforceOrThrow } = require('./util')
const { API_URLS, EXPLORER_URLS, RequestStatus, VerificationStatus } = require('./constants')

// const curlirize = require('axios-curlirize')
// // initializing axios-curlirize with your axios instance
// curlirize(axios);

module.exports = async (config) => {
  const options = parseConfig(config)

  // Verify each contract
  const contractNames = config._.slice(1)

  // Track which contracts failed verification
  const failedContracts = []
  for (const contractName of contractNames) {
    console.log(`Verifying ${contractName}`)
    try {
      const artifact = getArtifact(contractName, options)
      let status = await verifyContract(artifact, options)
      if (status === VerificationStatus.FAILED) {
        failedContracts.push(contractName)
      } else {
        // Add link to verified contract on Blockscout
        const contractAddress = artifact.networks[`${options.networkId}`].address
        const explorerUrl = `${EXPLORER_URLS[options.networkId]}/address/${contractAddress}/contracts`
        status += `: ${explorerUrl}`
      }
      console.log(status)
    } catch (e) {
      console.error(e.message)
      failedContracts.push(contractName)
    }
    console.log()
  }

  enforce(
    failedContracts.length === 0,
    `Failed to verify ${failedContracts.length} contract(s): ${failedContracts.join(', ')}`
  )

  console.log(`Successfully verified ${contractNames.length} contract(s).`)
}

const parseConfig = (config) => {
  console.log(Object.getOwnPropertyNames(config))
  // Truffle handles network stuff, just need network_id
  const networkId = config.network_id
  const networkName = config.network
  const apiUrl = API_URLS[networkId]
  enforce(apiUrl, `Blockscout has no support for network ${config.network} with id ${networkId}`)

  enforce(config._.length > 1, 'No contract name(s) specified')

  const workingDir = config.working_directory
  //const contractsBuildDir = config.contracts_build_directory
  const contractsBuildDir = workingDir + `/build/${networkName}/contracts/`
  if (!fs.statSync(contractsBuildDir).isDirectory())
    contractsBuildDir = config.contracts_build_directory
  const optimizerSettings = config.compilers.solc.settings.optimizer
  const verifyPreamble = config.verify && config.verify.preamble

  console.debug(`Contracts Build Dir ${contractsBuildDir}`)
  console.debug(`Working Dir ${workingDir}`)

  return {
    apiUrl,
    networkId,
    networkName,
    workingDir,
    contractsBuildDir,
    verifyPreamble,
    // Note: API docs state enabled = 0, disbled = 1, but empiric evidence suggests reverse
    optimizationUsed: optimizerSettings.enabled ? 1 : 0,
    runs: optimizerSettings.runs
  }
}

const getArtifact = (contractName, options) => {
  // Construct artifact path and read artifact
  const artifactPath = `${options.contractsBuildDir}/${contractName}.json`
  enforceOrThrow(fs.existsSync(artifactPath), `Could not find ${contractName} artifact at ${artifactPath}`)
  return require(artifactPath)
}

const verifyContract = async (artifact, options) => {
  enforceOrThrow(
    artifact.networks && artifact.networks[`${options.networkId}`],
    `No instance of contract ${artifact.contractName} found for network id ${options.networkId} and network name ${options.networkName}`
  )

  const res = await sendVerifyRequest(artifact, options)
  enforceOrThrow(res.data, `Failed to connect to Blockscout API at url ${options.apiUrl}`)

  if (res.data.result === VerificationStatus.ALREADY_VERIFIED) {
    return VerificationStatus.ALREADY_VERIFIED
  }

  enforceOrThrow(res.data.status === RequestStatus.OK, res.data.result)
  return verificationStatus(res.data.result, options)
}

const sendVerifyRequest = async (artifact, options) => {
  const encodedConstructorArgs = await fetchConstructorValues(artifact, options)
  const mergedSource = await fetchMergedSource(artifact, options)

  const postQueries = {
    // module: 'contract',
    // action: 'verifysourcecode',
    addressHash: artifact.networks[`${options.networkId}`].address,
    contractSourceCode: mergedSource,
    name: artifact.contractName,
    compilerVersion: `v${artifact.compiler.version.replace('.Emscripten.clang', '')}`,
    optimization: !options.optimizationUsed,
    optimizationRuns: options.runs,
    constructorArguments: encodedConstructorArgs
  }

  // Link libraries as specified in the artifact
  const libraries = artifact.networks[`${options.networkId}`].links || {}
  Object.entries(libraries).forEach(([key, value], i) => {
    enforceOrThrow(i < 5, 'Can not link more than 5 libraries with Blockscout API')
    postQueries[`library${i + 1}Name`] = key
    postQueries[`library${i + 1}Address`] = value
  })

  const verifyUrl = `${options.apiUrl}?module=contract&action=verify`
  console.log(`url: ${verifyUrl}, options: ${querystring.stringify(postQueries)}`)
  try {
    return axios.post(verifyUrl, querystring.stringify(postQueries))
  } catch (e) {
    console.debug(JSON.stringify(e));
    throw new Error(`Failed to connect to Blockscout API at url ${verifyUrl}`)
  }
  console.log("linea 127")
}

const fetchConstructorValues = async (artifact, options) => {
  const contractAddress = artifact.networks[`${options.networkId}`].address

  // Fetch the contract creation transaction to extract the input data
  let res
  try {
    // console.log(`${options.apiUrl}?module=account&action=txlist&address=${contractAddress}&page=1&sort=asc&offset=1`)
    res = await axios.get(
      `${options.apiUrl}?module=account&action=txlist&address=${contractAddress}&page=1&sort=asc&offset=1`
    )
  } catch (e) {
    throw new Error(`Failed to connect to Blockscout API at url ${options.apiUrl}`)
  }
  enforceOrThrow(res.data && res.data.status === RequestStatus.OK, 'Failed to fetch constructor arguments')
  // The last part of the transaction data is the constructor parameters
  return res.data.result[0].input.substring(artifact.bytecode.length)
}

const fetchMergedSource = async (artifact, options) => {
  enforceOrThrow(
    fs.existsSync(artifact.sourcePath),
    `Could not find ${artifact.contractName} source file at ${artifact.sourcePath}`
  )

  let mergedSource = await merge(artifact.sourcePath)
  // Include the preamble if it exists, removing all instances of */ for safety
  if (options.verifyPreamble) {
    const preamble = options.verifyPreamble.replace(/\*+\//g, '')
    mergedSource = `/**\n${preamble}\n*/\n\n${mergedSource}`
  }
  return mergedSource
}

const verificationStatus = async (guid, options) => {
  // Retry API call every second until status is no longer pending
  while (true) {
    await delay(1000)

    try {
      const verificationResult = await axios.get(
        `${options.apiUrl}?module=contract&action=checkverifystatus&guid=${guid}`
      )
      if (verificationResult.data.result !== VerificationStatus.PENDING) {
        return verificationResult.data.result
      }
    } catch (e) {
      throw new Error(`Failed to connect to Blockscout API at url ${options.apiUrl}`)
    }
  }
}
