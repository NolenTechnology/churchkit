import type { ExpoConfig, ConfigContext } from 'expo/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The app's identity, built from a brand file.
 *
 * Which church this build is for comes from CHURCH:
 *
 *   CHURCH=my-church npx expo start
 *   CHURCH=my-church eas build --profile production
 *
 * ChurchKit ships one codebase and many builds. Everything below that
 * differs per church — name, colours, icons, bundle identifiers, push and
 * error-reporting credentials — is read from `brands/<CHURCH>/brand.json`,
 * so no church's identity is ever committed to this repository.
 *
 * Two of these values can never change once the app has shipped. An iOS
 * bundle identifier and an Android package name are the app's identity in
 * each store: change either and the stores see a different app, and every
 * existing member is stranded on a version that no longer receives updates.
 * A church migrating an existing app onto ChurchKit must carry its original
 * identifiers — and its OneSignal app ID, or push stops reaching every
 * phone already carrying the app — into its brand file unchanged.
 */

interface Brand {
  slug: string;
  identity: { name: string; shortName: string; tagline?: string };
  colors: Record<string, string>;
  urls: Record<string, string>;
  assets?: Record<string, string>;
  mobile?: {
    scheme?: string;
    bundleIdentifier?: string;
    androidPackage?: string;
    splashBackgroundColor?: string;
    version?: string;
    iosBuildNumber?: string;
    androidVersionCode?: number;
    easProjectId?: string;
    // A church migrating an existing Expo project carries its original EAS
    // project's slug here too — EAS refuses to build when the config's
    // `slug` doesn't match the slug the linked `easProjectId` was
    // registered under, and that registered slug predates ChurchKit's
    // brand-folder naming, so it isn't always the same string as `slug`
    // above. Absent, this just falls back to the brand's own slug.
    expoSlug?: string;
    updatesUrl?: string;
    onesignalAppId?: string;
    sentryDsn?: string;
    associatedDomain?: string;
  };
}

function loadBrand(): Brand {
  const slug = process.env.CHURCH;
  if (!slug) {
    throw new Error(
      'CHURCH is not set. Run with CHURCH=<slug>, where brands/<slug>/brand.json exists. ' +
      'There is no default: a build with someone else\'s identity is worse than no build.'
    );
  }
  const path = resolve(__dirname, '../../brands', slug, 'brand.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Brand;
  } catch (e) {
    throw new Error(`Could not read ${path}: ${(e as Error).message}`);
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`brand.json is missing mobile.${name}, which every build needs.`);
  return value;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const brand = loadBrand();
  const m = brand.mobile ?? {};
  const assetDir = `../../brands/${brand.slug}`;
  const splashColor = m.splashBackgroundColor ?? brand.colors.brand;

  return {
    ...config,
    name: brand.identity.name,
    slug: m.expoSlug ?? brand.slug,
    scheme: required(m.scheme, 'scheme'),
    version: m.version ?? '1.0.0',
    orientation: 'default',
    userInterfaceStyle: 'light',
    newArchEnabled: false,
    icon: `${assetDir}/${brand.assets?.appIcon ?? 'assets/icon.png'}`,
    splash: {
      image: `${assetDir}/${brand.assets?.appSplash ?? 'assets/splash.png'}`,
      resizeMode: 'contain',
      backgroundColor: splashColor,
    },
    assetBundlePatterns: ['**/*'],
    runtimeVersion: { policy: 'appVersion' },
    ...(m.updatesUrl ? { updates: { url: m.updatesUrl } } : {}),

    ios: {
      supportsTablet: true,
      bundleIdentifier: required(m.bundleIdentifier, 'bundleIdentifier'),
      buildNumber: m.iosBuildNumber ?? '1',
      ...(m.associatedDomain ? { associatedDomains: [`applinks:${m.associatedDomain}`] } : {}),
      infoPlist: {
        UIBackgroundModes: ['audio'],
        ITSAppUsesNonExemptEncryption: false,
      },
    },

    android: {
      package: required(m.androidPackage, 'androidPackage'),
      versionCode: m.androidVersionCode ?? 1,
      adaptiveIcon: {
        foregroundImage: `${assetDir}/${brand.assets?.appIcon ?? 'assets/icon.png'}`,
        backgroundColor: splashColor,
      },
      permissions: [],
      blockedPermissions: ['com.google.android.gms.permission.AD_ID'],
      ...(m.associatedDomain
        ? {
            intentFilters: [
              {
                action: 'VIEW',
                autoVerify: true,
                data: [{ scheme: 'https', host: m.associatedDomain }],
                category: ['BROWSABLE', 'DEFAULT'],
              },
            ],
          }
        : {}),
    },

    plugins: [
      'expo-secure-store',
      [
        'expo-build-properties',
        {
          android: {
            enableMinifyInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
            // Sentry's bundled OpenTelemetry classes reference com.google.auto.value's
            // annotations, which are compile-time-only and never on the runtime
            // classpath. R8 treats that as a hard error once minification is on.
            extraProguardRules: '-dontwarn com.google.auto.value.**',
          },
        },
      ],
      ...(m.onesignalAppId
        ? [['onesignal-expo-plugin', { mode: 'production' }] as any]
        : []),
      ...(m.sentryDsn ? ['@sentry/react-native/expo'] : []),
    ],

    // Read at runtime via expo-constants. Anything absent here is a feature
    // this church did not configure, and the app hides it rather than
    // linking somewhere empty.
    extra: {
      churchName: brand.identity.name,
      shortName: brand.identity.shortName,
      // brand.json's urls.api is the real, permanent production address —
      // often still serving an old deployment right up until cutover. A
      // build meant to test a new backend first needs to reach it without
      // editing that file (and risking the edit surviving into a real
      // production build afterward), hence the override.
      apiBaseUrl: process.env.CHURCHKIT_API_BASE_OVERRIDE || brand.urls.api,
      websiteUrl: brand.urls.web,
      churchCenterUrl: brand.urls.churchCenter ?? null,
      givingUrl: brand.urls.giving ?? null,
      privacyPolicyUrl: brand.urls.privacy ?? null,
      termsUrl: brand.urls.terms ?? null,
      attendanceBaseUrl: m.associatedDomain ? `https://${m.associatedDomain}` : null,
      onesignalAppId: m.onesignalAppId ?? null,
      sentryDsn: m.sentryDsn ?? null,
      ...(m.easProjectId ? { eas: { projectId: m.easProjectId } } : {}),
    },
  };
};
