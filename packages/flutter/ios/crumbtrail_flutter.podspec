Pod::Spec.new do |s|
  s.name             = 'crumbtrail_flutter'
  s.version          = '0.1.0'
  s.summary          = 'Crumbtrail Flutter diagnostics bridge'
  s.description      = 'Optional native diagnostics bridge for the Crumbtrail Flutter SDK.'
  s.homepage         = 'https://crumbtrail.ai'
  s.license          = { :file => '../LICENSE' }
  s.author           = { 'Crumbtrail' => 'support@crumbtrail.ai' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.dependency 'Flutter'
  s.platform         = :ios, '12.0'
  s.swift_version    = '5.9'
end
