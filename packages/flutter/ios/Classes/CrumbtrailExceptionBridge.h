#import <Foundation/Foundation.h>

typedef void (*CrumbtrailFlutterExceptionCallback)(NSException *exception);

void crumbtrailFlutterInstallExceptionBridge(CrumbtrailFlutterExceptionCallback callback);
void crumbtrailFlutterRemoveExceptionBridge(void);
int crumbtrailFlutterExceptionBridgeInstalled(void);
