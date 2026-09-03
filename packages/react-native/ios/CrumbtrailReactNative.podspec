Pod::Spec.new do |s|
  s.name             = 'CrumbtrailReactNative'
  s.version          = '0.47.0'
  s.summary          = 'Crumbtrail React Native diagnostics bridge'
  s.description      = 'Optional native diagnostics bridge for the Crumbtrail React Native SDK.'
  s.homepage         = 'https://crumbtrail.ai'
  s.license          = { :type => 'MIT', :file => '../LICENSE' }
  s.author           = { 'Crumbtrail' => 'support@crumbtrail.ai' }
  s.source           = { :path => '.' }
  s.source_files     = '*.{h,m,mm,swift}'
  s.platform         = :ios, '13.0'
  s.requires_arc     = true
  s.dependency 'React-Core'
end
