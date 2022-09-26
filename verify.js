const axios = require('axios')
const delay = require('delay')
const { merge } = require('sol-merger')
const fs = require('fs')
const path = require('path')
const { enforce, enforceOrThrowError, enforceOrThrowWarn } = require('./util')
const { RequestStatus, VerificationStatus } = require('./constants')
const { newKit } = require('@celo/contractkit')
const kit = newKit('http://localhost:8545')

module.exports = async (config) => {
  const options = parseConfig(config)
  // Verify each contract
  let contractNames = config._.slice(1)

  // Track which contracts failed verification
  const failedContracts = []
  const notDeployedContracts = []
  const deployedContracts = []

  if (contractNames.includes('all')) {
    contractNames = await getAllContractFiles(options.contractsBuildDir)
  }
  for (const contractName of contractNames) {
    console.debug(`\r\nVerifying ${contractName}`)
    try {
      const artifact = getArtifact(contractName, options)
      // console.log(`Artifact: ${JSON.stringify(artifact, null, 2)}`)
      if (!enforceOrThrowWarn(
        artifact.networks && artifact.networks[`${options.networkId}`] && artifact.networks[`${options.networkId}`].address,
        `No instance of contract ${artifact.contractName} found for network id ${options.networkId} and network name ${options.networkName}\r\n`
      )) {
        // eslint-disable-next-line no-undef
        status = VerificationStatus.NOT_DEPLOYED
        notDeployedContracts.push(contractName)
        continue
      }

      const contractAddress = artifact.networks[`${options.networkId}`].address
      const explorerUrl = `${options.blockscoutUrl}/address/${contractAddress}/contracts`

      const verStatus = await checkVerificationStatus(contractAddress, options)
      if (verStatus === VerificationStatus.ALREADY_VERIFIED) {
        console.debug(`Contract ${contractName} at address ${contractAddress} already verified. Skipping: ${explorerUrl}`)
      } else {
        console.debug(`Contract ${contractName} at address ${contractAddress} not verified yet. Let's do it.`)

        let status = await verifyContract(artifact, options)
        if (status === VerificationStatus.NOT_VERIFIED) {
          failedContracts.push(contractName)
        } else {
          // Add link to verified contract on Blockscout
          status += `: ${explorerUrl}`
          deployedContracts.push(contractName)
        }
        console.debug(status)
      }
    } catch (e) {
      console.error(`Error ${e}`)
      failedContracts.push(contractName)
    }
    console.debug()
  }

  console.info(`\r\nContracts not deployed: ${notDeployedContracts.join(', ')}\r\n`)
  console.info(`\r\nSuccessfully verified ${deployedContracts.length} contract(s).\r\n`)

  enforceOrThrowError(
    failedContracts.length === 0,
    `\r\nFailed to verify ${failedContracts.length} contract(s): ${failedContracts.join(', ')}\r\n`
  )
}

const parseConfig = (config) => {
  // Truffle handles network stuff, just need network_id
  const networkId = config.network_id
  const networkName = config.network
  const blockscoutUrl = config.blockscoutUrl
  enforce(blockscoutUrl, `Blockscout has no support for network ${config.network} with id ${networkId}`)
  const apiUrl = `${blockscoutUrl}/api`

  enforce(config._.length > 1, 'No contract name(s) specified')

  const workingDir = config.working_directory
  let contractsBuildDir = config.contracts_build_directory

  if (fs.existsSync(`${workingDir}/build/${networkName}`) && fs.existsSync(`${workingDir}/build/${networkName}/contracts/`)) {
    contractsBuildDir = workingDir + `/build/${networkName}/contracts/`
  }
  const optimizerSettings = config.compilers.solc.settings.optimizer
  const verifyPreamble = config.verify && config.verify.preamble

  console.debug(`Contracts Build Dir ${contractsBuildDir}`)
  console.debug(`Working Dir ${workingDir}`)

  let optimization = false
  if (optimizerSettings.enabled.toNumber() === 1) {
    optimization = true
  }

  return {
    blockscoutUrl,
    apiUrl,
    networkId,
    networkName,
    workingDir,
    contractsBuildDir,
    verifyPreamble,
    // Note: API docs state enabled = 0, disbled = 1, but empiric evidence suggests reverse
    optimizationUsed: optimization,
    runs: optimizerSettings.runs
  }
}

const getArtifact = (contractName, options) => {
  // Construct artifact path and read artifact
  const artifactPath = `${options.contractsBuildDir}/${contractName}.json`
  enforceOrThrowError(fs.existsSync(artifactPath), `Could not find ${contractName} artifact at ${artifactPath}`)
  return require(artifactPath)
}

const verifyContract = async (artifact, options) => {
  enforceOrThrowError(
    artifact.networks && artifact.networks[`${options.networkId}`],
    `No instance of contract ${artifact.contractName} found for network id ${options.networkId} and network name ${options.networkName}`
  )

  const res = await sendVerifyRequest(artifact, options)
  enforceOrThrowError(res.data, `Failed to connect to Blockscout API at url ${options.apiUrl}`)

  if (res.data.result === VerificationStatus.ALREADY_VERIFIED) {
    return VerificationStatus.ALREADY_VERIFIED
  }

  enforceOrThrowError(res.data.status === RequestStatus.OK, res.data.result)
  const contractAddress = artifact.networks[`${options.networkId}`].address
  return checkVerificationStatus(contractAddress, options)
}

const sendVerifyRequest = async (artifact, options) => {
  const contractAddress = artifact.networks[`${options.networkId}`].address
  const encodedConstructorArgs = await fetchConstructorValues(artifact, options)
  const mergedSource = await fetchMergedSource(artifact, options)
  const contractProxyAddress = await getProxyAddress(artifact.contractName)
  console.log(`Contract Proxy address ${contractProxyAddress}`)

  var postQueries = {
    addressHash: contractAddress,
    contractSourceCode: mergedSource,
    name: artifact.contractName,
    compilerVersion: `v${artifact.compiler.version.replace('.Emscripten.clang', '')}`,
    optimization: options.optimizationUsed,
    optimizationRuns: options.runs,
    constructorArguments: encodedConstructorArgs
  }

  if (contractProxyAddress) {
    postQueries['proxyAddress'] = contractProxyAddress
  }

  // Link libraries as specified in the artifact
  const libraries = artifact.networks[`${options.networkId}`].links || {}
  Object.entries(libraries).forEach(([key, value], i) => {
    enforceOrThrowError(i < 5, 'Can not link more than 5 libraries with Blockscout API')
    postQueries[`library${i + 1}Name`] = key
    postQueries[`library${i + 1}Address`] = value
  })

  const verifyUrl = `${options.apiUrl}?module=contract&action=verify`
  try {
    return axios.post(verifyUrl, postQueries)
  } catch (e) {
    console.error(`Error verifying: ${e}`)
    throw new Error(`Failed to connect to Blockscout API at url ${verifyUrl}`)
  }
}

const fetchConstructorValues = async (artifact, options) => {
  const contractAddress = artifact.networks[`${options.networkId}`].address
  let res
  try {
    res = await axios.get(
      `${options.apiUrl}?module=account&action=txlist&address=${contractAddress}&page=1&sort=asc&offset=1`
    )
  } catch (e) {
    throw new Error(`Failed Fetching constructor values from Blockscout API at url ${options.apiUrl}`)
  }
  enforceOrThrowError(res.data && res.data.status === RequestStatus.OK, 'Failed to fetch constructor arguments')
  // constructorParameters
  return res.data.result[0].input.substring(artifact.bytecode.length)
}

const fetchMergedSource = async (artifact, options) => {
  enforceOrThrowError(
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

const checkVerificationStatus = async (address, options) => {
  // Retry API call every second until status is no longer pending
  let counter = 0
  const retries = 5
  while (counter < retries) {
    const url = `${options.apiUrl}?module=contract&action=getsourcecode&address=${address}&ignoreProxy=1`
    // console.debug(`Retrying contract verification[${counter}] for address ${address} at url: ${url}`)

    try {
      const result = await axios.get(url)
      if ('SourceCode' in result.data.result[0] && result.data.result[0].SourceCode.length > 0) {
        console.debug(`Contract at ${address} verified`)
        return VerificationStatus.ALREADY_VERIFIED
      }
    } catch (e) {
      console.error(`Error in verification status: ${e}`)
      throw new Error(`Failed to get verification status from Blockscout API at url ${options.apiUrl}`)
    }
    counter++
    await delay(1000)
  }
  console.debug(`Contract at ${address} source code not verified yet`)
  return VerificationStatus.NOT_VERIFIED
}

const getProxyAddress = async (contractName) => {
  try {
    console.log(`Contract Name: ${contractName}`)
    return await kit.registry.addressFor(contractName)
  } catch (e) {
    return false
  }
}

Object.assign(module.exports, {
  getProxyAddress,
  checkVerificationStatus
})

const getAllContractFiles = async (contractFolder) => {
  // contractFiles
  return fromDir(contractFolder, '.json')
}

const fromDir = async (folder, filter) => {
  let filesFiltered = []
  if (!fs.existsSync(folder)) {
    console.error(`Directory ${folder} does not exist. Exiting`)
    return filesFiltered
  }
  const files = fs.readdirSync(folder)
  filesFiltered = []
  let filename
  let stat
  for (const f of files) {
    filename = path.join(folder, f)
    stat = fs.lstatSync(filename)
    if (stat.isDirectory()) {
      fromDir(f, filter)
    } else if (path.parse(f).ext === filter) {
      filesFiltered.push(path.parse(f).name)
    }
  }
  return filesFiltered
}
