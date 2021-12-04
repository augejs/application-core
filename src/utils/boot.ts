/* eslint-disable @typescript-eslint/ban-types */
/* eslint-disable @typescript-eslint/no-explicit-any */
import cluster from 'cluster';
import yargsParse from 'yargs-parser';

import {
  scan,
  ScanNode,
  ScanContext,
  hookUtil,
  HookMetadata,
  Metadata,
} from '@augejs/provider-scanner';
import { getConfigAccessPath } from './config.util';
import { objectPath, objectExtend } from './object.util';
import { BindingScopeEnum, Container } from '../ioc';
import { Cluster, Config, ConfigLoader, Tag } from '../decorators';
import { Logger, ConsoleLogTransport } from '../logger';

const DefaultLifeCyclePhases = {
  startupLifecyclePhase: ['onInit', 'onAppWillReady', '__onAppReady__'],
  readyLifecyclePhase: ['onAppDidReady'],
  shutdownLifecyclePhase: ['onAppWillClose'],
};

interface BootOptions {
  containerOptions?: Record<string, any>;
  config?: Record<string, any>;
}

const logger = Logger.getLogger('boot');

export const boot = async (
  appModule: NewableFunction,
  options?: BootOptions,
): Promise<ScanContext> => {
  if (cluster.isMaster && Cluster.hasMetadata(appModule)) {
    const clusterOptions = Cluster.getMetadata(appModule);
    if (clusterOptions.enable) {
      const clusterModule = clusterOptions.clusterModule || Cluster.DefaultClusterModule;
      Metadata.decorate(
        [
          Cluster.ClusterMasterClassDecorator({
            workers: clusterOptions.workers,
          }),
        ],
        clusterModule,
      );
      appModule = clusterModule;
    }
  }

  return await scan(appModule, {
    // context level hooks.
    contextScanHook: hookUtil.nestHooks([
      async (context: ScanContext, next: CallableFunction) => {
        try {
          await next();
        } catch (err) {
          logger.error(`boot Error \n ${err?.stack || err?.message || err}`);
          // add default log transport.
          if (Logger.getTransportCount() === 0) {
            Logger.addTransport(new ConsoleLogTransport());
          }
          process.exit(1);
        }
      },
      bootLifeCyclePhases(),
      bootSetupEnv(options),
      bootLoadConfig(options),
      bootIoc(),
    ]),
    scanNodeScanHook: scanNodeInstantiation(),
  });
};

function bootSetupEnv(options?: BootOptions) {
  const containerOptions = {
    defaultScope: BindingScopeEnum.Singleton,
    autoBindInjectable: false,
    skipBaseClassChecks: true,
    ...(options?.containerOptions || {}),
  };
  const lifeCycleNames: string[] = Object.values(DefaultLifeCyclePhases).flat();
  return async (context: ScanContext, next: CallableFunction) => {
    // define context
    context.container = new Container(containerOptions);
    context.globalConfig = {};
    context.lifeCyclePhasesHooks = {};
    context.getScanNodeByProvider = (provider: object): ScanNode => {
      return Metadata.getMetadata(provider, provider) as ScanNode;
    };
    await hookUtil.traverseScanNodeHook(
      context.rootScanNode!,
      (scanNode: ScanNode) => {
        // bind the provider to scanNode.
        Metadata.defineMetadata(scanNode.provider, scanNode, scanNode.provider);
        // lifecycle
        scanNode.lifeCycleNodes = {};
        lifeCycleNames.forEach((lifeCycleName: string) => {
          (scanNode.lifeCycleNodes as any)[lifeCycleName] = {};
        });
        scanNode.getConfig = (path?: string): any => {
          const configAccessPath: string = getConfigAccessPath(
            scanNode.namePaths,
            path,
          );
          return objectPath.get(
            scanNode.context.globalConfig as object,
            configAccessPath,
          );
        };
        return null;
      },
      hookUtil.sequenceHooks,
    )(null, hookUtil.noopNext);
    await next();
  };
}

function bootLoadConfig(options?: BootOptions) {
  return async (context: ScanContext, next: CallableFunction) => {
    await hookUtil.traverseScanNodeHook(
      context.rootScanNode!,
      () => {
        return async (scanNode: ScanNode, next: CallableFunction) => {
          await next();
          const configAccessPath: string = getConfigAccessPath(
            scanNode.namePaths,
          );
          const globalConfig: object = scanNode.context.globalConfig as object;
          // provide config.
          // https://www.npmjs.com/package/object-path
          const providerConfig: object = Config.getMetadata(scanNode.provider);
          const providerConfigLoader: Function = ConfigLoader.getMetadata(
            scanNode.provider,
          );
          const providerConfigLoaderConfigResult: any =
            await providerConfigLoader(scanNode);
          if (providerConfigLoaderConfigResult !== undefined) {
            objectExtend<object, object>(
              true,
              providerConfig,
              providerConfigLoaderConfigResult,
            );
          }
          // current override previous
          let preProviderConfig: any = objectPath.get(
            globalConfig,
            configAccessPath,
          );
          if (preProviderConfig) {
            objectExtend<object, object>(
              true,
              preProviderConfig,
              providerConfig,
            );
          } else {
            preProviderConfig = providerConfig;
          }
          // https://www.npmjs.com/package/extend
          objectPath.set<object>(
            globalConfig,
            configAccessPath,
            preProviderConfig,
          );
        };
      },
      hookUtil.nestHooks,
    )(null, hookUtil.noopNext);

    // the external global config has highest priority
    objectExtend<object, object>(true, context.globalConfig as object, {
      ...(options?.config || yargsParse(process.argv.slice(2))),
    });
    await next();
  };
}

function bootIoc() {
  return async (context: ScanContext, next: CallableFunction) => {
    await hookUtil.traverseScanNodeHook(
      context.rootScanNode!,
      () => {
        return async (scanNode: ScanNode, next: CallableFunction) => {
          const container: Container = scanNode.context.container as Container;
          const provider: any = scanNode.provider;
          // here we need deal with kinds of provider value.
          if (typeof provider === 'function') {
            container.bind(provider).toSelf();
            scanNode.instanceFactory = () => {
              return container.get(provider);
            };
          } else if (typeof provider === 'object') {
            // https://github.com/inversify/InversifyJS#the-inversifyjs-features-and-api
            const identifier: any = provider?.id;
            if (identifier) {
              if (provider.useValue) {
                container.bind(identifier).toConstantValue(provider.useValue);
                scanNode.instanceFactory = () => {
                  return container.get(identifier);
                };
              } else if (typeof provider.useClass === 'function') {
                container.bind(identifier).to(provider.useClass);
                scanNode.instanceFactory = () => {
                  return container.get(identifier);
                };
              } else if (typeof provider.useFactory === 'function') {
                const factoryResult = await provider.useFactory(
                  container,
                  scanNode.parent,
                );
                if (factoryResult) {
                  if (typeof factoryResult === 'function') {
                    container.bind(identifier).to(factoryResult);
                    scanNode.instanceFactory = () => {
                      return container.get(identifier);
                    };
                  } else {
                    container.bind(identifier).toConstantValue(factoryResult);
                    scanNode.instanceFactory = () => {
                      return container.get(identifier);
                    };
                  }
                }
              }
            }
          }
          await next();
        };
      },
      hookUtil.nestReversedHooks,
    )(null, hookUtil.noopNext);
    await next();
  };
}

function scanNodeInstantiation() {
  return async (scanNode: ScanNode, next: CallableFunction) => {
    await next();
    let instance: any = null;
    const instanceFactory: CallableFunction | undefined =
      scanNode.instanceFactory as CallableFunction;
    if (instanceFactory) {
      instance = await instanceFactory();
    }
    scanNode.instance = instance;
    // add  self life cycle
    if (instance) {
      // keep the reference to scanNode
      instance.$scanNode = scanNode;
      // here is tags in constructor
      if (Tag.hasMetadata(scanNode.provider)) {
        Tag.getMetadata(scanNode.provider).forEach((tag: string) => {
          (scanNode.context.container as Container)
            .bind(tag)
            .toConstantValue(instance);
        });
      }
    }
  };
}

function bootLifeCyclePhases() {
  const lifeCyclePhases: Record<string, string[]> = DefaultLifeCyclePhases;
  return async (context: ScanContext, next: CallableFunction) => {
    await next();
    // last step
    Object.keys(lifeCyclePhases).forEach((lifeCyclePhaseName: string) => {
      const lifeCycleNames: string[] = lifeCyclePhases[lifeCyclePhaseName];
      const lifeCyclePhaseHook = hookUtil.sequenceHooks(
        lifeCycleNames.map((lifecycleName: string) => {
          return hookUtil.traverseScanNodeHook(
            context.rootScanNode!,
            (scanNode: ScanNode) => {
              const instance: any = scanNode.instance;
              const hasLifecycleFunction: boolean =
                instance && typeof instance[lifecycleName] === 'function';
              return hookUtil.nestHooks([
                ...HookMetadata.getMetadata(
                  (scanNode.lifeCycleNodes as any)[lifecycleName],
                ),
                async (scanNode: ScanNode, next: CallableFunction) => {
                  if (hasLifecycleFunction) {
                    await instance[lifecycleName](scanNode);
                  }
                  await next();
                },
              ]);
            },
            hookUtil.nestReversedHooks,
          );
        }),
      );

      const lifeCyclePhasesHooks: Record<string, CallableFunction> =
        context.lifeCyclePhasesHooks as Record<string, CallableFunction>;
      lifeCyclePhasesHooks[lifeCyclePhaseName] = async () => {
        await lifeCyclePhaseHook(context, hookUtil.noopNext);
      };
    });

    const lifeCyclePhasesHooks: Record<string, CallableFunction> =
      context.lifeCyclePhasesHooks as Record<string, CallableFunction>;
    await lifeCyclePhasesHooks.startupLifecyclePhase();
    process.nextTick(async () => {
      try {
        // add default log transport.
        if (Logger.getTransportCount() === 0) {
          Logger.addTransport(new ConsoleLogTransport());
        }
        await lifeCyclePhasesHooks.readyLifecyclePhase();
        // report the container self is ready
        process.send?.({ cmd: '__onAppReady__' });
      } catch (err) {
        logger.error(`Ready Error \n ${err?.stack || err?.message || err}`);
      }
    });

    //shutdown
    // https://hackernoon.com/graceful-shutdown-in-nodejs-2f8f59d1c357
    // https://blog.risingstack.com/graceful-shutdown-node-js-kubernetes/
    process.once('SIGTERM', async () => {
      try {
        await lifeCyclePhasesHooks.shutdownLifecyclePhase();
      } catch (err) {
        logger.error(`ShutDown Error \n ${err?.stack || err?.message || err}`);
      }
      process.exit();
    });
  };
}
