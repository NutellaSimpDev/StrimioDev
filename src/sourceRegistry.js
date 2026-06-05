export const legalSources = {
  internet_archive: {
    providerName: 'Internet Archive',
    sourceType: 'public_domain',
    licenseType: 'public archive / public domain review required',
    licenseUrl: 'https://archive.org/details/movies',
    rightsholder: 'Varies by item',
    allowedTerritories: ['*'],
    commercialUseAllowed: false,
    verificationStatus: 'approved',
    reviewedBy: 'Strimio source registry',
    reviewedAt: '2026-06-04'
  },
  official_site: {
    providerName: 'Official site',
    sourceType: 'official_api',
    licenseType: 'official publisher page',
    licenseUrl: '',
    rightsholder: 'Official publisher',
    allowedTerritories: ['*'],
    commercialUseAllowed: false,
    verificationStatus: 'metadata_only',
    reviewedBy: 'Strimio source registry',
    reviewedAt: '2026-06-04'
  },
  jikan_mal: {
    providerName: 'Jikan / MyAnimeList metadata',
    sourceType: 'official_api',
    licenseType: 'metadata only',
    licenseUrl: 'https://docs.api.jikan.moe/',
    rightsholder: 'MyAnimeList / respective licensors',
    allowedTerritories: ['*'],
    commercialUseAllowed: false,
    verificationStatus: 'metadata_only',
    reviewedBy: 'Strimio source registry',
    reviewedAt: '2026-06-04'
  },
  user_owned: {
    providerName: 'User owned media',
    sourceType: 'owned',
    licenseType: 'user supplied rights',
    licenseUrl: '',
    rightsholder: 'User / uploader',
    allowedTerritories: ['*'],
    commercialUseAllowed: false,
    verificationStatus: 'requires_user_assertion',
    reviewedBy: 'User',
    reviewedAt: '2026-06-04'
  }
};

export function getSourcePolicy(providerId) {
  return legalSources[providerId] || null;
}

export function canPlaySource(source) {
  const policy = getSourcePolicy(source.providerId);
  if (!policy) {
    return {
      allowed: false,
      reason: 'Provider no registrado en SourceRegistry.'
    };
  }

  if (!['approved', 'requires_user_assertion'].includes(policy.verificationStatus)) {
    return {
      allowed: false,
      reason: 'Provider registrado solo para metadata, no para reproduccion.'
    };
  }

  if (!source.url || !/^https:\/\//i.test(source.url)) {
    return {
      allowed: false,
      reason: 'La fuente reproducible debe usar HTTPS.'
    };
  }

  return {
    allowed: true,
    policy,
    reason: 'Fuente aprobada para reproduccion interna.'
  };
}

export function getRegistryStats() {
  const entries = Object.values(legalSources);
  return {
    total: entries.length,
    playable: entries.filter((source) => ['approved', 'requires_user_assertion'].includes(source.verificationStatus)).length,
    metadataOnly: entries.filter((source) => source.verificationStatus === 'metadata_only').length
  };
}
