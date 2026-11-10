package main

import "golang.org/x/sys/windows"

func processCPU() (cpuMeasurement, error) {
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(windows.CurrentProcess(), &creation, &exit, &kernel, &user); err != nil {
		return cpuMeasurement{}, err
	}
	kernelTicks := uint64(kernel.HighDateTime)<<32 | uint64(kernel.LowDateTime)
	userTicks := uint64(user.HighDateTime)<<32 | uint64(user.LowDateTime)
	seconds := float64(kernelTicks+userTicks) / 10000000
	return cpuMeasurement{seconds: &seconds, status: "available"}, nil
}
