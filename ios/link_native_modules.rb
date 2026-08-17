require 'xcodeproj'

project_path = 'AttendanceApp.xcodeproj'
project = Xcodeproj::Project.open(project_path)

# Find the main app target
target = project.targets.find { |t| t.name == 'AttendanceApp' }

# Find or create a group for native modules
group = project.main_group.find_subpath(File.join('AttendanceApp'), true)

# Add Swift file
swift_file_path = 'AttendanceApp/BLEBroadcasterModule.swift'
unless group.files.any? { |f| f.path == swift_file_path }
  swift_ref = group.new_file(swift_file_path)
  target.add_file_references([swift_ref])
  puts "Added BLEBroadcasterModule.swift to target"
end

# Add Obj-C Bridge file
bridge_file_path = 'AttendanceApp/BLEBroadcasterBridge.m'
unless group.files.any? { |f| f.path == bridge_file_path }
  bridge_ref = group.new_file(bridge_file_path)
  target.add_file_references([bridge_ref])
  puts "Added BLEBroadcasterBridge.m to target"
end

# Remove deleted AudioDSP files if they exist in the project
audio_swift = group.files.find { |f| f.path == 'AttendanceApp/AudioDSPModule.swift' }
if audio_swift
  audio_swift.remove_from_project
  puts "Removed AudioDSPModule.swift from project"
end

audio_bridge = group.files.find { |f| f.path == 'AttendanceApp/AudioDSPBridge.m' }
if audio_bridge
  audio_bridge.remove_from_project
  puts "Removed AudioDSPBridge.m from project"
end

project.save
puts "Successfully updated project.pbxproj"

# Set bridging header
target.build_configurations.each do |config|
  config.build_settings['SWIFT_OBJC_BRIDGING_HEADER'] = 'AttendanceApp/AttendanceApp-Bridging-Header.h'
end

project.save
puts "Successfully set Bridging Header"
